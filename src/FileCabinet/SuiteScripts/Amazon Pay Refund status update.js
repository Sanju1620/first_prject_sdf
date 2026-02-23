/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/record', 'N/search', 'N/https', 'N/log'],
    function (record, search, https, log) {

        var LAMBDA_URL = 'https://72gdgq3m324tgrzxibnomiu2su0holos.lambda-url.eu-north-1.on.aws';

        function getInputData() {
            return search.create({
                type: "customerrefund",
                settings: [{ "name": "consolidationtype", "value": "ACCTTYPE" }],
                filters: [
                    ["type", "anyof", "CustRfnd"],
                    "AND",
                    ["custbody_amznpay_transtatus", "is", "RefundInitiated"],
                    "AND",
                    ["mainline", "is", "T"]
                ],
                columns: [
                    search.createColumn({ name: "internalid", label: "Internal ID" }),
                    search.createColumn({ name: "custbody_amazon_refund_id", label: "Refund Id" })
                ]
            });
        }

        function map(context) {
            var result = JSON.parse(context.value);
            var refundId = result.values.custbody_amazon_refund_id;

            if (!refundId) return;

            var payload = {
                method: 'get_refund_status',
                refundId: refundId
            };

            var response = https.post({
                url: LAMBDA_URL,
                body: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' }
            });

            var responseBody = JSON.parse(response.body);
            log.debug('Lambda response', responseBody);

            var refundData = responseBody.data;
            var refundState = refundData.statusDetails && refundData.statusDetails.state;
            var refundAmount = parseFloat(refundData.refundAmount && refundData.refundAmount.amount || 0);
            var refundCurrency = refundData.refundAmount && refundData.refundAmount.currencyCode || '';
            var refundIdResp = refundData.refundId;

            context.write({
                key: result.id,
                value: JSON.stringify({
                    refundState: refundState,
                    refundAmount: refundAmount,
                    refundCurrency: refundCurrency,
                    refundIdResp: refundIdResp
                })
            });
        }

        function reduce(context) {
            var refundRecordId = context.key;
            var data = JSON.parse(context.values[0]);

            log.audit('Reduce started', { refundRecordId: refundRecordId, data: data });

            try {
                var refundRecord = record.load({
                    type: record.Type.CUSTOMER_REFUND,
                    id: refundRecordId
                });

                var creditMemoId = refundRecord.getSublistValue({
                    sublistId: 'apply',
                    fieldId: 'internalid',
                    line: 0
                });

                if (!creditMemoId) {
                    log.error('No credit memo found for refund ID ' + refundRecordId);
                    return;
                }

                var creditMemo = record.load({
                    type: record.Type.CREDIT_MEMO,
                    id: creditMemoId
                });

                var returnAuthId = creditMemo.getValue({ fieldId: 'createdfrom' });
                if (!returnAuthId) {
                    log.error('No return authorization for credit memo ID ' + creditMemoId);
                    return;
                }

                var returnAuth = record.load({
                    type: record.Type.RETURN_AUTHORIZATION,
                    id: returnAuthId
                });

                var cashSaleId = returnAuth.getValue({ fieldId: 'createdfrom' });
                if (!cashSaleId) {
                    log.error('No cash sale for return authorization ID ' + returnAuthId);
                    return;
                }

                var salesOrderField = search.lookupFields({
                    type: search.Type.TRANSACTION,
                    id: cashSaleId,
                    columns: ['createdfrom']
                });

                var salesOrderId = salesOrderField && salesOrderField.createdfrom && salesOrderField.createdfrom[0] && salesOrderField.createdfrom[0].value;
                if (!salesOrderId) {
                    log.error('No sales order for cash sale ID ' + cashSaleId);
                    return;
                }

                var recordsToUpdate = [
                    { type: record.Type.CUSTOMER_REFUND, id: refundRecordId },
                    { type: record.Type.CREDIT_MEMO, id: creditMemoId },
                    { type: record.Type.RETURN_AUTHORIZATION, id: returnAuthId },
                    { type: record.Type.CASH_SALE, id: cashSaleId },
                    { type: record.Type.SALES_ORDER, id: salesOrderId }
                ];

                for (var i = 0; i < recordsToUpdate.length; i++) {
                    var recInfo = recordsToUpdate[i];
                    try {
                        var rec = record.load({ type: recInfo.type, id: recInfo.id });

                        rec.setValue({ fieldId: 'custbody_amznpay_transtatus', value: data.refundState });
                        rec.setValue({ fieldId: 'custbody_amazonpay_refunded_amount', value: data.refundAmount });
                        rec.setValue({ fieldId: 'custbody_amazon_refund_id', value: data.refundIdResp });

                        rec.save();
                        log.audit('Updated record: ' + recInfo.type, 'ID: ' + recInfo.id);
                    } catch (e) {
                        log.error('Error updating record ' + recInfo.type + ' ID ' + recInfo.id, e.message);
                    }
                }

            } catch (e) {
                log.error('Unexpected error during reduce for refund ID ' + refundRecordId, e);
            }
        }

        return {
            getInputData: getInputData,
            map: map,
            reduce: reduce
        };
    });
