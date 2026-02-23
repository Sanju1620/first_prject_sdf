/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * 
 * @name TVR | SL | Amazon Pay Capture Service
 * @description Suitelet to handle Amazon Pay capture API calls
 * 
 * @author Tvarana
 * @version 1.2.0
 */

define([
    'N/log',
    'N/https',
    'N/runtime',
    'N/record',
    'N/file',
    'N/format',
    'N/encode',
    'N/crypto',
    'N/crypto/certificate'
], function (log, https, runtime, record, file, format, encode, crypto, certificate) {
    'use strict';

    // Configuration
    const CONFIG = {
        MERCHANT_ID: 'A18B8YNAUI54RV',
        PUBLIC_KEY_ID: 'SANDBOX-AF2GBD6AOXEYZ56CPU2VVBPN',
        CERTIFICATE_ID: '', // Certificate ID from Setup > Company > Certificates (if using certificate)
        PRIVATE_KEY_FILE_ID: null, // File Cabinet ID of your private key
        REGION: 'us',
        SANDBOX: true,
        API_VERSION: 'v2',
        
        // Custom Field IDs
        FIELDS: {
            AMAZON_TRANS_DETAILS: 'custbody_amznpy_trandetails',
            AMAZON_CAPTURE_ID: 'custbody_amznpy_capture_id',
            AMAZON_CAPTURE_STATUS: 'custbody_amznpy_capture_status',
            AMAZON_CAPTURE_AMOUNT: 'custbody_amznpy_capture_amount',
            AMAZON_CAPTURE_DATE: 'custbody_amznpy_capture_date'
        }
    };

    /**
     * Get API base URL
     */
    function getApiBaseUrl() {
        const baseUrls = {
            'us': CONFIG.SANDBOX ? 'https://pay-api.amazon.com/sandbox' : 'https://pay-api.amazon.com',
            'eu': CONFIG.SANDBOX ? 'https://pay-api.amazon.eu/sandbox' : 'https://pay-api.amazon.eu',
            'jp': CONFIG.SANDBOX ? 'https://pay-api.amazon.jp/sandbox' : 'https://pay-api.amazon.jp'
        };
        return baseUrls[CONFIG.REGION] || baseUrls['us'];
    }

    /**
     * Get API host
     */
    function getApiHost() {
        const hosts = {
            'us': 'pay-api.amazon.com',
            'eu': 'pay-api.amazon.eu',
            'jp': 'pay-api.amazon.jp'
        };
        return hosts[CONFIG.REGION] || hosts['us'];
    }

    /**
     * Create SHA256 hash
     */
    function sha256Hash(data) {
        const hashObj = crypto.createHash({
            algorithm: crypto.HashAlg.SHA256
        });
        hashObj.update({
            input: data,
            inputEncoding: encode.Encoding.UTF_8
        });
        return hashObj.digest({
            outputEncoding: encode.Encoding.HEX
        }).toLowerCase();
    }

    /**
     * Get ISO timestamp
     */
    function getIsoTimestamp() {
        return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    /**
     * Create canonical request
     */
    function createCanonicalRequest(method, path, headers, payload) {
        const sortedHeaderKeys = Object.keys(headers).sort();
        
        const canonicalHeaders = sortedHeaderKeys
            .map(key => key.toLowerCase() + ':' + headers[key].trim())
            .join('\n');
        
        const signedHeaders = sortedHeaderKeys
            .map(key => key.toLowerCase())
            .join(';');
        
        const payloadHash = sha256Hash(payload || '');
        
        const canonicalRequest = [
            method.toUpperCase(),
            path,
            '',
            canonicalHeaders,
            '',
            signedHeaders,
            payloadHash
        ].join('\n');
        
        return {
            canonicalRequest: canonicalRequest,
            signedHeaders: signedHeaders
        };
    }

    /**
     * Sign string using NetSuite Certificate
     * Requires certificate to be uploaded in Setup > Company > Certificates
     */
    function signWithCertificate(stringToSign) {
        try {
            if (!CONFIG.CERTIFICATE_ID) {
                throw new Error('Certificate ID not configured. Please upload your Amazon Pay private key as a certificate in NetSuite.');
            }

            const signer = certificate.createSigner({
                certId: CONFIG.CERTIFICATE_ID,
                algorithm: certificate.HashAlg.SHA256
            });

            signer.update({
                input: stringToSign,
                inputEncoding: encode.Encoding.UTF_8
            });

            const signature = signer.sign({
                outputEncoding: encode.Encoding.BASE64
            });

            return signature;
        } catch (e) {
            log.error('signWithCertificate Error', e.message);
            throw new Error('Failed to sign request: ' + e.message);
        }
    }

    /**
     * Sign using HMAC (alternative for testing - won't work with Amazon Pay but useful for debugging)
     */
    function signWithHmac(stringToSign, secretKey) {
        const hmac = crypto.createHmac({
            algorithm: crypto.HashAlg.SHA256,
            key: {
                encoding: encode.Encoding.UTF_8,
                secret: secretKey
            }
        });
        
        hmac.update({
            input: stringToSign,
            inputEncoding: encode.Encoding.UTF_8
        });
        
        return hmac.digest({
            outputEncoding: encode.Encoding.BASE64
        });
    }

    /**
     * Generate authorization header
     */
    function generateAuthHeader(method, path, payload, timestamp) {
        const headers = {
            'accept': 'application/json',
            'content-type': 'application/json',
            'x-amz-pay-date': timestamp,
            'x-amz-pay-host': getApiHost(),
            'x-amz-pay-region': CONFIG.REGION
        };

        const { canonicalRequest, signedHeaders } = createCanonicalRequest(method, path, headers, payload);
        
        log.debug('generateAuthHeader', 'Canonical Request:\n' + canonicalRequest);
        
        const canonicalRequestHash = sha256Hash(canonicalRequest);
        const stringToSign = 'AMZN-PAY-RSASSA-PSS-V2\n' + canonicalRequestHash;
        
        log.debug('generateAuthHeader', 'String to Sign: ' + stringToSign);

        // Sign using certificate
        const signature = signWithCertificate(stringToSign);

        const authHeader = 'AMZN-PAY-RSASSA-PSS-V2 ' +
            'PublicKeyId=' + CONFIG.PUBLIC_KEY_ID + ', ' +
            'SignedHeaders=' + signedHeaders + ', ' +
            'Signature=' + signature;

        return {
            authorization: authHeader,
            headers: headers
        };
    }

    /**
     * Make API request
     */
    function makeApiRequest(method, endpoint, payload) {
        const baseUrl = getApiBaseUrl();
        const path = '/' + CONFIG.API_VERSION + endpoint;
        const url = baseUrl + path;
        const timestamp = getIsoTimestamp();
        const payloadStr = payload ? JSON.stringify(payload) : '';

        log.debug('makeApiRequest', 'URL: ' + url + ', Method: ' + method);

        try {
            const { authorization, headers } = generateAuthHeader(method, path, payloadStr, timestamp);

            const requestHeaders = {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': authorization,
                'x-amz-pay-date': timestamp,
                'x-amz-pay-host': getApiHost(),
                'x-amz-pay-region': CONFIG.REGION
            };

            let response;
            if (method.toUpperCase() === 'POST') {
                response = https.post({
                    url: url,
                    headers: requestHeaders,
                    body: payloadStr
                });
            } else {
                response = https.get({
                    url: url,
                    headers: requestHeaders
                });
            }

            log.debug('makeApiRequest', 'Response Code: ' + response.code);

            return {
                code: response.code,
                body: response.body ? JSON.parse(response.body) : null
            };

        } catch (e) {
            log.error('makeApiRequest Error', e.message);
            return { code: 500, error: e.message };
        }
    }

    /**
     * Capture charge
     */
    function captureCharge(chargeId, amount, currencyCode, softDescriptor) {
        log.audit('captureCharge', 'Capturing: ' + chargeId + ', Amount: ' + amount + ' ' + currencyCode);

        const endpoint = '/charges/' + chargeId + '/capture';
        const payload = {
            captureAmount: {
                amount: amount,
                currencyCode: currencyCode
            }
        };

        if (softDescriptor) {
            payload.softDescriptor = softDescriptor;
        }

        const response = makeApiRequest('POST', endpoint, payload);

        if (response.code === 200 || response.code === 201) {
            return { success: true, data: response.body };
        } else {
            return { success: false, error: response.body || response.error, code: response.code };
        }
    }

    /**
     * Get charge
     */
    function getCharge(chargeId) {
        const endpoint = '/charges/' + chargeId;
        const response = makeApiRequest('GET', endpoint, null);

        if (response.code === 200) {
            return { success: true, data: response.body };
        } else {
            return { success: false, error: response.body || response.error, code: response.code };
        }
    }

    /**
     * Update Sales Order
     */
    function updateSalesOrder(orderId, captureResult) {
        if (!orderId) return;

        try {
            const captureData = captureResult.data || captureResult;
            const updateValues = {};

            if (captureData.captureId) {
                updateValues[CONFIG.FIELDS.AMAZON_CAPTURE_ID] = captureData.captureId;
            }
            if (captureData.statusDetails && captureData.statusDetails.state) {
                updateValues[CONFIG.FIELDS.AMAZON_CAPTURE_STATUS] = captureData.statusDetails.state;
            }
            if (captureData.captureAmount) {
                updateValues[CONFIG.FIELDS.AMAZON_CAPTURE_AMOUNT] = captureData.captureAmount.amount;
            }
            updateValues[CONFIG.FIELDS.AMAZON_CAPTURE_DATE] = format.format({
                value: new Date(),
                type: format.Type.DATETIME
            });

            record.submitFields({
                type: record.Type.SALES_ORDER,
                id: orderId,
                values: updateValues,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            log.audit('updateSalesOrder', 'Order ' + orderId + ' updated');
        } catch (e) {
            log.error('updateSalesOrder Error', e.message);
        }
    }

    /**
     * Handle POST
     */
    function handlePost(request, response) {
        let result = { success: false, error: 'Unknown error' };

        try {
            const body = JSON.parse(request.body);
            
            switch (body.method) {
                case 'capture_charge':
                    result = captureCharge(body.chargeId, body.amount, body.currencyCode || 'USD', body.softDescriptor);
                    if (result.success && body.orderId) {
                        updateSalesOrder(body.orderId, result);
                    }
                    break;
                case 'get_charge':
                    result = getCharge(body.chargeId);
                    break;
                default:
                    result = { success: false, error: 'Unknown method: ' + body.method };
            }
        } catch (e) {
            log.error('handlePost Error', e.message);
            result = { success: false, error: e.message };
        }

        response.write({ output: JSON.stringify(result) });
    }

    /**
     * Entry point
     */
    function onRequest(context) {
        context.response.setHeader({ name: 'Content-Type', value: 'application/json' });

        if (context.request.method === 'POST') {
            handlePost(context.request, context.response);
        } else {
            context.response.write({ output: JSON.stringify({ success: false, error: 'Method not allowed' }) });
        }
    }

    return { onRequest: onRequest };
});