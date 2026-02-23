/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * 
 * @name TVR | UE | Amazon Pay Capture
 * @description Capture Amazon Pay payment on Cash Sale creation - Non-blocking with error handling
 */

define([
    'N/record',
    'N/log',
    'N/https',
    'N/search',
    'N/format'
], function (record, log, https, search, format) {
    'use strict';

    const CONFIG = {
        LAMBDA_URL: 'https://72gdgq3m324tgrzxibnomiu2su0holos.lambda-url.eu-north-1.on.aws',

        FIELDS: {
            AMAZON_TRANS_DETAILS: 'custbody_amznpy_trandetails',
            AMAZON_CHARGE_ID: 'custbody_amznpay_chargeid',
            AMAZON_CAPTURE_ID: 'custbody_amznpy_capture_id',
            AMAZON_CAPTURE_STATUS: 'custbody_amznpy_capture_status',
            AMAZON_CAPTURE_AMOUNT: 'custbody_amznpy_capture_amount',
            AMAZON_CAPTURE_DATE: 'custbody_amznpy_capture_date'
        }
    };

    /**
     * Call Lambda - Returns result, never throws
     */
    function callLambda(payload) {
        log.debug('callLambda', 'Payload: ' + JSON.stringify(payload));

        try {
            const response = https.post({
                url: CONFIG.LAMBDA_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            log.debug('callLambda', 'Response Code: ' + response.code + ', Body: ' + response.body);

            const responseBody = JSON.parse(response.body || '{}');
            const parsedBody = typeof responseBody.body === 'string' 
                ? JSON.parse(responseBody.body) 
                : responseBody;

            // Return with status code for better error handling
            return {
                success: response.code === 200 && parsedBody.success !== false,
                code: response.code,
                data: parsedBody.data || null,
                error: parsedBody.error || (response.code !== 200 ? 'HTTP ' + response.code : null)
            };

        } catch (e) {
            log.error('callLambda Error', e.message);
            return {
                success: false,
                code: 0,
                data: null,
                error: 'Lambda call failed: ' + e.message
            };
        }
    }

    function getAmazonPayDetails(rec) {
        try {
            const transDetailsStr = rec.getValue({
                fieldId: CONFIG.FIELDS.AMAZON_TRANS_DETAILS
            });

            if (!transDetailsStr) return null;

            return JSON.parse(transDetailsStr);
        } catch (e) {
            log.error('getAmazonPayDetails Error', e.message);
            return null;
        }
    }

    function isAmazonPayOrder(rec) {
        const transDetails = rec.getValue({
            fieldId: CONFIG.FIELDS.AMAZON_TRANS_DETAILS
        });

        if (transDetails) {
            try {
                const details = JSON.parse(transDetails);
                return !!(details.chargeId || details.chargePermissionId);
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    function isAlreadyCaptured(rec) {
        const captureStatus = rec.getValue({ fieldId: CONFIG.FIELDS.AMAZON_CAPTURE_STATUS });
        
        // Check if already processed (success or failure)
        const processedStatuses = ['Captured', 'Completed', 'Failed', 'Authorization Expired', 'Authorization Closed'];
        return processedStatuses.includes(captureStatus);
    }

    function getOrderTotal(rec) {
        const total = rec.getValue({ fieldId: 'total' });
        const currency = rec.getValue({ fieldId: 'currency' });

        let currencyCode = 'USD';
        if (currency) {
            try {
                const currencyLookup = search.lookupFields({
                    type: search.Type.CURRENCY,
                    id: currency,
                    columns: ['symbol']
                });
                currencyCode = currencyLookup.symbol || 'USD';
            } catch (e) { }
        }

        return {
            amount: parseFloat(total).toFixed(2),
            currencyCode: currencyCode
        };
    }

    /**
     * Determine failure reason from error response
     */
    function getFailureReason(error, httpCode) {
        if (!error) return 'Unknown Error';

        const errorStr = typeof error === 'string' ? error.toLowerCase() : JSON.stringify(error).toLowerCase();

        // Check for specific Amazon Pay errors
        if (errorStr.includes('authorization') && (errorStr.includes('expired') || errorStr.includes('closed'))) {
            return 'Authorization Expired';
        }
        if (errorStr.includes('invalidchargepermissionstatus') || errorStr.includes('charge permission') && errorStr.includes('closed')) {
            return 'Authorization Closed';
        }
        if (errorStr.includes('chargeamountexceeded') || errorStr.includes('amount exceeded')) {
            return 'Amount Exceeded';
        }
        if (errorStr.includes('invalidchargestatus')) {
            return 'Invalid Charge Status';
        }
        if (errorStr.includes('transactionamountexceeded')) {
            return 'Transaction Amount Exceeded';
        }
        if (errorStr.includes('softdecline') || errorStr.includes('hard decline')) {
            return 'Payment Declined';
        }
        if (httpCode === 422) {
            return 'Authorization Expired/Closed';
        }
        if (httpCode === 400) {
            return 'Invalid Request';
        }
        if (httpCode === 404) {
            return 'Charge Not Found';
        }
        if (httpCode === 500 || httpCode === 502 || httpCode === 503) {
            return 'Amazon Pay Service Error';
        }

        return 'Capture Failed';
    }

    /**
     * Capture the charge - Returns result, never throws
     */
    function captureCharge(chargeId, amount, currencyCode) {
        log.audit('captureCharge', 'Capturing: ' + chargeId + ', Amount: ' + amount + ' ' + currencyCode);

        const response = callLambda({
            method: 'capture_charge',
            chargeId: chargeId,
            amount: amount,
            currencyCode: currencyCode || 'USD',
            softDescriptor: 'Order Payment'
        });

        if (response.success && response.data) {
            return { 
                success: true, 
                data: response.data,
                status: response.data.statusDetails ? response.data.statusDetails.state : 'Captured'
            };
        } else {
            const failureReason = getFailureReason(response.error, response.code);
            return { 
                success: false, 
                error: response.error,
                status: failureReason,
                httpCode: response.code
            };
        }
    }

    /**
     * Close the charge permission - Returns result, never throws
     */
    function closeChargePermission(chargePermissionId) {
        log.audit('closeChargePermission', 'Closing: ' + chargePermissionId);

        const response = callLambda({
            method: 'close_charge_permission',
            chargePermissionId: chargePermissionId,
            closureReason: 'Order completed - full payment captured',
            cancelPendingCharges: false
        });

        if (response.success) {
            log.audit('closeChargePermission', 'Closed successfully');
            return { success: true };
        } else {
            log.warn('closeChargePermission', 'Failed to close: ' + response.error);
            return { success: false, error: response.error };
        }
    }

    /**
     * Update record with capture result (success or failure)
     */
    function updateRecordWithCaptureResult(recordType, recordId, captureResult, permissionClosed, amazonDetails) {
        try {
            const updateValues = {};
            const captureData = captureResult.data || {};

            // Set capture status (success or failure reason)
            updateValues[CONFIG.FIELDS.AMAZON_CAPTURE_STATUS] = captureResult.status || 'Unknown';

            // Set capture date/time
            updateValues[CONFIG.FIELDS.AMAZON_CAPTURE_DATE] = format.format({
                value: new Date(),
                type: format.Type.DATETIME
            });

            // If successful, set capture ID and amount
            if (captureResult.success) {
                if (captureData.captureId) {
                    updateValues[CONFIG.FIELDS.AMAZON_CAPTURE_ID] = captureData.captureId;
                }
                if (captureData.captureAmount) {
                    updateValues[CONFIG.FIELDS.AMAZON_CAPTURE_AMOUNT] = captureData.captureAmount.amount;
                }
            }

            // Update transaction details JSON
            try {
                const rec = record.load({ type: recordType, id: recordId });
                const existingDetails = rec.getValue({ fieldId: CONFIG.FIELDS.AMAZON_TRANS_DETAILS });

                if (existingDetails) {
                    const details = JSON.parse(existingDetails);
                    
                    // Always update these fields
                    details.captureAttempted = true;
                    details.captureTimestamp = new Date().toISOString();
                    details.captureSuccess = captureResult.success;
                    details.captureStatus = captureResult.status;
                    
                    if (captureResult.success) {
                        details.captureId = captureData.captureId || '';
                        details.captureAmount = captureData.captureAmount ? captureData.captureAmount.amount : '';
                        details.chargePermissionClosed = permissionClosed;
                    } else {
                        details.captureError = captureResult.error || 'Unknown error';
                        details.captureHttpCode = captureResult.httpCode;
                    }

                    updateValues[CONFIG.FIELDS.AMAZON_TRANS_DETAILS] = JSON.stringify(details);
                }
            } catch (e) {
                log.debug('Could not update trans details JSON', e.message);
            }

            record.submitFields({
                type: recordType,
                id: recordId,
                values: updateValues,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            log.audit('updateRecordWithCaptureResult', 'Record ' + recordId + ' updated with status: ' + captureResult.status);

        } catch (e) {
            // Even this should not fail the main process
            log.error('updateRecordWithCaptureResult Error', e.message);
        }
    }

    /**
     * Main capture process - Never throws, always returns
     */
    function processCapture(rec, recordType, recordId) {
        log.audit('processCapture', 'Processing: ' + recordType + ' ' + recordId);

        const amazonDetails = getAmazonPayDetails(rec);

        if (!amazonDetails || !amazonDetails.chargeId) {
            log.debug('processCapture', 'No Amazon Pay charge ID found');
            return { success: false, status: 'No Charge ID', error: 'No Amazon Pay charge ID found' };
        }

        const amountDetails = getOrderTotal(rec);
        log.audit('processCapture', 'Amount: ' + JSON.stringify(amountDetails));

        // Step 1: Attempt to capture the charge
        const captureResult = captureCharge(
            amazonDetails.chargeId,
            amountDetails.amount,
            amountDetails.currencyCode
        );

        // Step 2: If capture successful, try to close charge permission
        let permissionClosed = false;
        if (captureResult.success && amazonDetails.chargePermissionId) {
            const closeResult = closeChargePermission(amazonDetails.chargePermissionId);
            permissionClosed = closeResult.success;
        }

        // Step 3: Update record with result (success or failure)
        updateRecordWithCaptureResult(recordType, recordId, captureResult, permissionClosed, amazonDetails);

        return captureResult;
    }

    /**
     * afterSubmit - Non-blocking, never throws errors to user
     */
    function afterSubmit(context) {
        // Only process on CREATE
        if (context.type !== context.UserEventType.CREATE) {
            return;
        }

        const newRecord = context.newRecord;
        const recordId = newRecord.id;
        const recordType = newRecord.type;

        // Wrap everything in try-catch to ensure Cash Sale creation is never blocked
        try {
            log.debug('afterSubmit', 'Processing ' + recordType + ': ' + recordId);

            const rec = record.load({
                type: recordType,
                id: recordId,
                isDynamic: false
            });

            // Check if Amazon Pay order
            if (!isAmazonPayOrder(rec)) {
                log.debug('afterSubmit', 'Not an Amazon Pay order');
                return;
            }

            log.audit('afterSubmit', 'Amazon Pay order detected: ' + recordId);

            // Check if already processed
            if (isAlreadyCaptured(rec)) {
                log.debug('afterSubmit', 'Already processed');
                return;
            }

            // Process capture (will handle its own errors)
            const result = processCapture(rec, recordType, recordId);

            if (result.success) {
                log.audit('afterSubmit', 'Capture completed for ' + recordId + ', Status: ' + result.status);
            } else {
                // Log error but DO NOT throw - Cash Sale should still be created
                log.error('afterSubmit', 'Capture failed for ' + recordId + ', Status: ' + result.status + ', Error: ' + result.error);
            }

        } catch (e) {
            // Catch ANY unexpected error - never block Cash Sale creation
            log.error('afterSubmit Unexpected Error', {
                message: e.message,
                stack: e.stack,
                recordId: recordId
            });
            
            // Try to update the record with error status
            try {
                record.submitFields({
                    type: recordType,
                    id: recordId,
                    values: {
                        [CONFIG.FIELDS.AMAZON_CAPTURE_STATUS]: 'Error: ' + e.message.substring(0, 50)
                    },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
            } catch (updateError) {
                log.error('afterSubmit', 'Could not update error status: ' + updateError.message);
            }
        }

        // Never throw - always return gracefully
        return;
    }

    return {
        afterSubmit: afterSubmit
    };
});