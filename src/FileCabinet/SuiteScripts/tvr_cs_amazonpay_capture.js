/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 * 
 * @name TVR | CS | Amazon Pay Capture
 * @description Client Script for manual Amazon Pay capture button on Sales Order
 * 
 * @author Tvarana
 * @version 1.0.0
 */

define([
    'N/currentRecord',
    'N/https',
    'N/url',
    'N/ui/dialog',
    'N/ui/message'
], function (currentRecord, https, url, dialog, message) {
    'use strict';

    // Configuration - Update with your Suitelet deployment details
    const CONFIG = {
        SUITELET_SCRIPT_ID: 'customscript_tvr_sl_amazonpay_capture',
        SUITELET_DEPLOYMENT_ID: 'customdeploy_tvr_sl_amazonpay_capture',

        FIELDS: {
            AMAZON_TRANS_DETAILS: 'custbody_amznpy_trandetails',
            AMAZON_CAPTURE_STATUS: 'custbody_amznpy_capture_status'
        }
    };

    /**
     * Get Amazon Pay transaction details
     */
    function getAmazonPayDetails(rec) {
        const transDetailsStr = rec.getValue({
            fieldId: CONFIG.FIELDS.AMAZON_TRANS_DETAILS
        });

        if (!transDetailsStr) {
            return null;
        }

        try {
            return JSON.parse(transDetailsStr);
        } catch (e) {
            console.error('Failed to parse Amazon Pay details:', e);
            return null;
        }
    }

    /**
     * Show loading message
     */
    function showLoading(msg) {
        return message.create({
            title: 'Processing',
            message: msg || 'Processing Amazon Pay capture...',
            type: message.Type.INFORMATION
        }).show();
    }

    /**
     * Hide loading message
     */
    function hideLoading(loadingMsg) {
        if (loadingMsg) {
            loadingMsg.hide();
        }
    }

    /**
     * Process the capture
     */
    function processCapture(rec, amazonDetails) {
        const loadingMsg = showLoading('Capturing Amazon Pay payment...');

        try {
            // Get Suitelet URL
            const suiteletUrl = url.resolveScript({
                scriptId: CONFIG.SUITELET_SCRIPT_ID,
                deploymentId: CONFIG.SUITELET_DEPLOYMENT_ID,
                returnExternalUrl: false
            });

            // Get order details
            const orderId = rec.id;
            const total = rec.getValue({ fieldId: 'total' });

            // Make capture request
            const payload = {
                method: 'capture_charge',
                chargeId: amazonDetails.chargeId,
                amount: parseFloat(total).toFixed(2),
                currencyCode: 'USD',
                orderId: orderId
            };

            https.post.promise({
                url: suiteletUrl,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            }).then(function (response) {
                hideLoading(loadingMsg);

                const result = JSON.parse(response.body);

                if (result.success) {
                    dialog.alert({
                        title: 'Success',
                        message: 'Payment captured successfully!\n\n' +
                            'Capture ID: ' + (result.data ? result.data.captureId : result.captureId)
                    }).then(function () {
                        window.location.reload();
                    });
                } else {
                    dialog.alert({
                        title: 'Capture Failed',
                        message: 'Failed to capture payment:\n\n' +
                            (result.error ? JSON.stringify(result.error) : 'Unknown error')
                    });
                }
            }).catch(function (error) {
                hideLoading(loadingMsg);

                dialog.alert({
                    title: 'Error',
                    message: 'An error occurred while capturing payment:\n\n' + error.message
                });
            });

        } catch (e) {
            hideLoading(loadingMsg);

            dialog.alert({
                title: 'Error',
                message: 'An error occurred:\n\n' + e.message
            });
        }
    }

    /**
     * Process refund
     */
    function processRefund(rec, amazonDetails, amount) {
        const loadingMsg = showLoading('Processing refund...');

        try {
            const suiteletUrl = url.resolveScript({
                scriptId: CONFIG.SUITELET_SCRIPT_ID,
                deploymentId: CONFIG.SUITELET_DEPLOYMENT_ID,
                returnExternalUrl: false
            });

            const payload = {
                method: 'refund_charge',
                chargeId: amazonDetails.chargeId,
                amount: parseFloat(amount).toFixed(2),
                currencyCode: 'USD'
            };

            https.post.promise({
                url: suiteletUrl,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            }).then(function (response) {
                hideLoading(loadingMsg);

                const result = JSON.parse(response.body);

                if (result.success) {
                    dialog.alert({
                        title: 'Success',
                        message: 'Refund processed successfully!\n\n' +
                            'Refund ID: ' + (result.data ? result.data.refundId : '')
                    }).then(function () {
                        window.location.reload();
                    });
                } else {
                    dialog.alert({
                        title: 'Refund Failed',
                        message: 'Failed to process refund:\n\n' +
                            (result.error ? JSON.stringify(result.error) : 'Unknown error')
                    });
                }
            }).catch(function (error) {
                hideLoading(loadingMsg);

                dialog.alert({
                    title: 'Error',
                    message: 'An error occurred:\n\n' + error.message
                });
            });

        } catch (e) {
            hideLoading(loadingMsg);

            dialog.alert({
                title: 'Error',
                message: 'An error occurred:\n\n' + e.message
            });
        }
    }

    /**
     * Page Init - REQUIRED entry point for Client Script
     * @param {Object} context
     */
    function pageInit(context) {
        console.log('Amazon Pay Client Script loaded');
    }

    /**
     * Capture Amazon Pay payment
     * Called from button click on Sales Order
     */
    function captureAmazonPay() {
        const rec = currentRecord.get();

        // Get Amazon Pay details
        const amazonDetails = getAmazonPayDetails(rec);

        if (!amazonDetails || !amazonDetails.chargeId) {
            dialog.alert({
                title: 'Error',
                message: 'No Amazon Pay charge found on this order.'
            });
            return;
        }

        // Check current status
        const captureStatus = rec.getValue({
            fieldId: CONFIG.FIELDS.AMAZON_CAPTURE_STATUS
        });

        if (captureStatus === 'Completed') {
            dialog.alert({
                title: 'Already Captured',
                message: 'This payment has already been captured.'
            });
            return;
        }

        // Confirm capture
        dialog.confirm({
            title: 'Capture Payment',
            message: 'Are you sure you want to capture the Amazon Pay payment for this order?\n\n' +
                'Charge ID: ' + amazonDetails.chargeId + '\n' +
                'Amount: $' + rec.getValue({ fieldId: 'total' })
        }).then(function (result) {
            if (result) {
                processCapture(rec, amazonDetails);
            }
        });
    }

    /**
     * Get charge status
     */
    function getChargeStatus() {
        const rec = currentRecord.get();
        const amazonDetails = getAmazonPayDetails(rec);

        if (!amazonDetails || !amazonDetails.chargeId) {
            dialog.alert({
                title: 'Error',
                message: 'No Amazon Pay charge found on this order.'
            });
            return;
        }

        const loadingMsg = showLoading('Getting charge status...');

        try {
            const suiteletUrl = url.resolveScript({
                scriptId: CONFIG.SUITELET_SCRIPT_ID,
                deploymentId: CONFIG.SUITELET_DEPLOYMENT_ID,
                returnExternalUrl: false
            });

            const payload = {
                method: 'get_charge',
                chargeId: amazonDetails.chargeId
            };

            https.post.promise({
                url: suiteletUrl,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            }).then(function (response) {
                hideLoading(loadingMsg);

                const result = JSON.parse(response.body);

                if (result.success && result.data) {
                    const charge = result.data;
                    dialog.alert({
                        title: 'Charge Status',
                        message: 'Charge ID: ' + charge.chargeId + '\n' +
                            'Status: ' + (charge.statusDetails ? charge.statusDetails.state : 'Unknown') + '\n' +
                            'Amount: ' + (charge.chargeAmount ? charge.chargeAmount.amount + ' ' + charge.chargeAmount.currencyCode : 'N/A') + '\n' +
                            'Created: ' + (charge.creationTimestamp || 'N/A')
                    });
                } else {
                    dialog.alert({
                        title: 'Error',
                        message: 'Failed to get charge status:\n\n' +
                            (result.error ? JSON.stringify(result.error) : 'Unknown error')
                    });
                }
            }).catch(function (error) {
                hideLoading(loadingMsg);

                dialog.alert({
                    title: 'Error',
                    message: 'An error occurred:\n\n' + error.message
                });
            });

        } catch (e) {
            hideLoading(loadingMsg);

            dialog.alert({
                title: 'Error',
                message: 'An error occurred:\n\n' + e.message
            });
        }
    }

    /**
     * Refund Amazon Pay payment
     */
    function refundAmazonPay() {
        const rec = currentRecord.get();
        const amazonDetails = getAmazonPayDetails(rec);

        if (!amazonDetails || !amazonDetails.chargeId) {
            dialog.alert({
                title: 'Error',
                message: 'No Amazon Pay charge found on this order.'
            });
            return;
        }

        const captureStatus = rec.getValue({
            fieldId: CONFIG.FIELDS.AMAZON_CAPTURE_STATUS
        });

        if (captureStatus !== 'Completed') {
            dialog.alert({
                title: 'Cannot Refund',
                message: 'Payment must be captured before it can be refunded.'
            });
            return;
        }

        dialog.confirm({
            title: 'Refund Payment',
            message: 'Are you sure you want to refund this payment?'
        }).then(function (result) {
            if (result) {
                processRefund(rec, amazonDetails, rec.getValue({ fieldId: 'total' }));
            }
        });
    }

    return {
        pageInit: pageInit,
        captureAmazonPay: captureAmazonPay,
        getChargeStatus: getChargeStatus,
        refundAmazonPay: refundAmazonPay
    };
});