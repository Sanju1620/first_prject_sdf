/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/https', 'N/url', 'N/search'],

    (record, https, url, search) => {

        const beforeLoad = (scriptContext) => {
            var refundRecord = scriptContext.newRecord;
            log.debug('refundRecord from SDF deployment testing processsing', refundRecord)
            var paymentMethod = refundRecord.getValue({ fieldId: 'paymentmethod' });
            log.debug('paymentMethod', paymentMethod)

            if (!paymentMethod) {
                var creditMemoId = refundRecord.getSublistValue({
                    sublistId: 'apply',
                    fieldId: 'internalid',
                    line: 0
                });

                var creditMemoRecord = record.load({
                    type: record.Type.CREDIT_MEMO,
                    id: creditMemoId,
                    isDynamic: true
                });

                var createdfrom = creditMemoRecord.getValue({ fieldId: 'createdfrom' });
                var returnAuthRecord = record.load({
                    type: record.Type.RETURN_AUTHORIZATION,
                    id: createdfrom,
                    isDynamic: true
                });

                createdfrom = returnAuthRecord.getValue({ fieldId: 'createdfrom' });
                var salesOrder = record.load({
                    type: record.Type.SALES_ORDER,
                    id: createdfrom,
                    isDynamic: true
                });

                var soPaymentMethod = salesOrder.getValue({ fieldId: 'paymentmethod' });
                refundRecord.setValue({ fieldId: 'paymentmethod', value: soPaymentMethod });
            }
        };

        const GetRefundableAmount = (salesOrder) => {
            var total = Number(salesOrder.getValue({ fieldId: 'total' }) || 0);
            log.debug('total', total)
            var shipping = Number(salesOrder.getValue({ fieldId: 'shippingcost' }) || 0);
            var taxRate = Number(salesOrder.getValue({ fieldId: 'shippingtax1rate' }) || 0);
            var taxAmount = (shipping * taxRate) / 100;
            return total - shipping - taxAmount;
        };

        function getSalesOrderFromSource(sourceId) {
            let currentId = sourceId;
            let recordType;

            while (true) {
                const result = search.lookupFields({
                    type: search.Type.TRANSACTION,
                    id: currentId,
                    columns: ['recordtype', 'createdfrom']
                });

                recordType = result.recordtype;

                // If this is the Sales Order, break
                if (recordType === 'salesorder') {
                    return {
                        id: currentId,
                        type: record.Type.SALES_ORDER
                    };
                }

                // If no more "createdfrom", can't go further
                if (!result.createdfrom || !result.createdfrom.length) {
                    throw new Error('Unable to trace back to Sales Order from record ID: ' + sourceId);
                }

                currentId = result.createdfrom[0].value;
            }
        }

        const afterSubmit = (scriptContext) => {
            const refundRecord = record.load({
                type: scriptContext.newRecord.type,
                id: scriptContext.newRecord.id,
                isDynamic: true
            });

            const paymenteventresult = refundRecord.getValue({ fieldId: 'paymenteventresult' });
            log.debug('paymenteventresult', paymenteventresult)
            if (paymenteventresult !== 'ACCEPT') return;

            var creditMemoId = refundRecord.getSublistValue({
                sublistId: 'apply',
                fieldId: 'internalid',
                line: 0
            });

            var creditMemo = record.load({
                type: record.Type.CREDIT_MEMO,
                id: creditMemoId,
                isDynamic: true
            });

            var createdfrom = creditMemo.getValue({ fieldId: 'createdfrom' });
            log.debug('createdfrom', createdfrom)
            var returnAuth = record.load({
                type: record.Type.RETURN_AUTHORIZATION,
                id: createdfrom,
                isDynamic: true
            });

            createdfrom = returnAuth.getValue({ fieldId: 'createdfrom' });

            var recordType = search.lookupFields({
                type: search.Type.TRANSACTION,
                id: createdfrom,
                columns: ['recordtype']
            }).recordtype;
            log.debug('recordType', recordType)

            var salesOrderInfo = getSalesOrderFromSource(createdfrom);
            log.debug('salesOrderInfo', salesOrderInfo)
            var salesOrder = record.load({
                type: salesOrderInfo.type,
                id: salesOrderInfo.id,
                isDynamic: true
            });
            log.debug('salesOrder', salesOrder)

            // Load the immediate source (could be Cash Sale, Invoice, etc.)
            var cashSaleRecord = record.load({
                type: recordType,
                id: createdfrom,
                isDynamic: true
            });

            var amazonChargeId = creditMemo.getValue({ fieldId: 'custbody_amznpay_chargeid' });
            var amount = parseFloat(creditMemo.getValue({ fieldId: 'total' }) || 0);
            var currency = creditMemo.getValue({ fieldId: 'currencysymbol' });
            var soStatus = salesOrder.getValue({ fieldId: 'custbody_amznpay_transtatus' });
            var currentStatus = refundRecord.getValue({ fieldId: 'custbody_amznpay_transtatus' });

            if (currentStatus !== 'REFUNDED' && (soStatus === 'Completed' || soStatus === 'PARTIALLY REFUNDED')) {
                var suiteletUrl = url.resolveScript({
                    scriptId: 'customscript_refund_amazonpay',
                    deploymentId: 'customdeploy_refund_amazonpay',
                    returnExternalUrl: true
                });

                var response = https.post({
                    url: suiteletUrl,
                    body: JSON.stringify({ chargeId: amazonChargeId, amount: amount, currency: currency }),
                    headers: { 'Content-Type': 'application/json' }
                });

                var res = JSON.parse(response.body);
                log.debug('res', res)
                if (res.refundStatus === 'RefundInitiated') {
                    const refundData = res.raw?.data || {};

                    const refundId = refundData.refundId;
                    const refundAmount = refundData.refundAmount?.amount || amount;
                    const refundCurrency = refundData.refundAmount?.currencyCode || currency;
                    const refundState = refundData.statusDetails?.state || 'RefundInitiated';

                    // Update Credit Memo
                    creditMemo.setValue({ fieldId: 'custbody_amznpay_transtatus', value: refundState });
                    creditMemo.setValue({ fieldId: 'custbody_amazonpay_refunded_amount', value: refundAmount });
                    creditMemo.setValue({ fieldId: 'custbody_amazon_refund_id', value: refundId });
                    creditMemo.save();

                    // Update Return Authorization
                    returnAuth.setValue({ fieldId: 'custbody_amznpay_transtatus', value: refundState });
                    returnAuth.setValue({ fieldId: 'custbody_amazonpay_refunded_amount', value: refundAmount });
                    returnAuth.setValue({ fieldId: 'custbody_amazon_refund_id', value: refundId });
                    returnAuth.save();

                    //Update Cash sale
                    var existingRefundedAmount = Number(cashSaleRecord.getValue({ fieldId: 'custbody_amazonpay_refunded_amount' }) || 0);
                    var newRefundedAmount = existingRefundedAmount + parseFloat(refundAmount);

                    cashSaleRecord.setValue({ fieldId: 'custbody_amznpay_transtatus', value: refundState });
                    cashSaleRecord.setValue({ fieldId: 'custbody_amazonpay_refunded_amount', value: newRefundedAmount });
                    cashSaleRecord.setValue({ fieldId: 'custbody_amazon_refund_id', value: refundId });
                    cashSaleRecord.save();

                    // Update Sales Order
                    var refundedAmount = Number(salesOrder.getValue({ fieldId: 'custbody_amazonpay_refunded_amount' }) || 0);
                    refundedAmount += parseFloat(refundAmount);
                    var refundable = GetRefundableAmount(salesOrder);
                    log.debug('refundedAmount', refundedAmount)
                    log.debug('refundable', refundable)
                    if (Math.floor(refundable) <= Math.floor(refundedAmount)) {
                        salesOrder.setValue({ fieldId: 'custbody_amznpay_transtatus', value: refundState });
                    } else {
                        salesOrder.setValue({ fieldId: 'custbody_amznpay_transtatus', value: 'PARTIALLY REFUNDED' });
                    }

                    salesOrder.setValue({ fieldId: 'custbody_amazonpay_refunded_amount', value: refundedAmount });
                    salesOrder.setValue({ fieldId: 'custbody_amazon_refund_id', value: refundId });
                    salesOrder.save();

                    // Update Refund record
                    const updatedRefund = record.load({
                        type: refundRecord.type,
                        id: refundRecord.id,
                        isDynamic: true
                    });

                    updatedRefund.setValue({ fieldId: 'custbody_amznpay_chargeid', value: amazonChargeId });
                    updatedRefund.setValue({ fieldId: 'custbody_amazonpay_refunded_amount', value: refundAmount });
                    updatedRefund.setValue({ fieldId: 'custbody_amznpay_transtatus', value: refundState });
                    updatedRefund.setValue({ fieldId: 'custbody_amazon_refund_id', value: refundId });
                    updatedRefund.save();
                }
            }
        };

        return { beforeLoad, afterSubmit };
    }
);
