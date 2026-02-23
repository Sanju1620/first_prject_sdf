/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * 
 * @name TVR | UE | Amazon Pay Void
 * @description Void/Cancel Amazon Pay charge when Sales Order is closed before fulfillment
 */

define([
    'N/record',
    'N/log',
    'N/https'
], function (record, log, https) {
    'use strict';

    const CONFIG = {
        LAMBDA_URL: 'https://72gdgq3m324tgrzxibnomiu2su0holos.lambda-url.eu-north-1.on.aws',

        FIELDS: {
            AMAZON_TRANS_DETAILS: 'custbody_amznpy_trandetails',
            AMAZON_VOID_STATUS: 'custbody_amznpy_void_status',
            AMAZON_VOID_DATE: 'custbody_amznpy_void_date'
        },

        // Statuses that trigger void
        VOID_STATUSES: ['Closed', 'Cancelled']
    };

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

            if (response.code !== 200) {
                throw new Error('Lambda failed: ' + response.body);
            }

            const responseBody = JSON.parse(response.body || '{}');
            return typeof responseBody.body === 'string' ? JSON.parse(responseBody.body) : responseBody;

        } catch (e) {
            log.error('callLambda Error', e.message);
            throw e;
        }
    }

    function getAmazonPayDetails(rec) {
        try {
            const detailsStr = rec.getValue({ fieldId: CONFIG.FIELDS.AMAZON_TRANS_DETAILS });
            return detailsStr ? JSON.parse(detailsStr) : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Check if charge is in a state that can be voided/cancelled
     */
    function getChargeStatus(chargeId) {
        try {
            const response = callLambda({
                method: 'get_charge',
                chargeId: chargeId
            });

            if (response.success && response.data) {
                return response.data.statusDetails ? response.data.statusDetails.state : null;
            }
            return null;
        } catch (e) {
            log.error('getChargeStatus Error', e.message);
            return null;
        }
    }

    /**
     * Cancel an authorized charge (void)
     */
    function cancelCharge(chargeId, reason) {
        log.audit('cancelCharge', 'Cancelling charge: ' + chargeId);

        try {
            const response = callLambda({
                method: 'cancel_charge',
                chargeId: chargeId,
                cancellationReason: reason || 'Order cancelled'
            });

            if (response.success !== false) {
                log.audit('cancelCharge', 'Charge cancelled successfully');
                return { success: true, data: response.data };
            } else {
                return { success: false, error: response.error };
            }
        } catch (e) {
            log.error('cancelCharge Error', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Close charge permission (for cleanup)
     */
    function closeChargePermission(chargePermissionId, reason) {
        log.audit('closeChargePermission', 'Closing: ' + chargePermissionId);

        try {
            const response = callLambda({
                method: 'close_charge_permission',
                chargePermissionId: chargePermissionId,
                closureReason: reason || 'Order cancelled',
                cancelPendingCharges: true // Cancel any pending charges
            });

            return { success: response.success !== false };
        } catch (e) {
            log.warn('closeChargePermission Error', e.message);
            return { success: false, error: e.message };
        }
    }

    function updateRecordWithVoidDetails(recordType, recordId, amazonDetails, voidResult) {
        try {
            const updateValues = {};

            updateValues[CONFIG.FIELDS.AMAZON_VOID_STATUS] = voidResult.success ? 'Voided' : 'Void Failed';
            updateValues[CONFIG.FIELDS.AMAZON_VOID_DATE] = new Date().toISOString();

            // Update transaction details
            const rec = record.load({ type: recordType, id: recordId });
            const existingDetails = rec.getValue({ fieldId: CONFIG.FIELDS.AMAZON_TRANS_DETAILS });

            if (existingDetails) {
                const details = JSON.parse(existingDetails);
                details.voidStatus = voidResult.success ? 'Voided' : 'Void Failed';
                details.voidTimestamp = new Date().toISOString();
                details.voidReason = 'Order cancelled/closed';

                updateValues[CONFIG.FIELDS.AMAZON_TRANS_DETAILS] = JSON.stringify(details);
            }

            record.submitFields({
                type: recordType,
                id: recordId,
                values: updateValues,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            log.audit('updateRecordWithVoidDetails', 'Record updated: ' + recordId);

        } catch (e) {
            log.error('updateRecordWithVoidDetails Error', e.message);
        }
    }

    function afterSubmit(context) {
        // Only process on CANCEL (status change)
        if (context.type !== context.UserEventType.CANCEL) {
            return;
        }

        const newRecord = context.newRecord;

        const recordId = newRecord.id;
        const recordType = newRecord.type;

        // Load full record
        const rec = record.load({
            type: recordType,
            id: recordId
        });

        // Get Amazon Pay details
        const amazonDetails = getAmazonPayDetails(rec);

        if (!amazonDetails) {
            log.debug('afterSubmit', 'Not an Amazon Pay order');
            return;
        }

        // Check if already voided
        if (amazonDetails.voidStatus === 'Voided') {
            log.debug('afterSubmit', 'Already voided');
            return;
        }

        // Check if already captured - if captured, cannot void (need refund instead)
        if (amazonDetails.captureStatus === 'Captured' || amazonDetails.captureStatus === 'Completed') {
            log.warn('afterSubmit', 'Charge already captured - cannot void, need refund');
            return;
        }

        log.audit('afterSubmit', 'Processing void for order: ' + recordId);

        let voidResult = { success: false };

        // Try to cancel the charge if it exists and is in authorized state
        if (amazonDetails.chargeId) {
            const chargeStatus = getChargeStatus(amazonDetails.chargeId);
            log.debug('afterSubmit', 'Current charge status: ' + chargeStatus);

            if (chargeStatus === 'Authorized' || chargeStatus === 'Open') {
                voidResult = cancelCharge(amazonDetails.chargeId, 'Order cancelled in NetSuite');
            } else if (chargeStatus === 'Captured') {
                log.warn('afterSubmit', 'Charge already captured - cannot cancel');
            } else {
                log.debug('afterSubmit', 'Charge not in cancellable state: ' + chargeStatus);
            }
        }

        // Also close the charge permission
        if (amazonDetails.chargePermissionId) {
            closeChargePermission(amazonDetails.chargePermissionId, 'Order cancelled');
        }

        // Update record
        updateRecordWithVoidDetails(recordType, recordId, amazonDetails, voidResult);

        if (voidResult.success) {
            log.audit('afterSubmit', 'Void completed for order: ' + recordId);
        } else {
            log.error('afterSubmit', 'Void failed: ' + voidResult.error);
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});