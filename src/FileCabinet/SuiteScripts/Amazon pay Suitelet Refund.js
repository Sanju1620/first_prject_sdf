/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/https', 'N/log', 'N/runtime'], function (https, log, runtime) {

    function onRequest(context) {
        log.debug('context', context)

        if (context.request.method === 'POST') {
            try {
                var requestBody = JSON.parse(context.request.body);
                log.debug('requestBody', requestBody)

                var chargeId = requestBody.chargeId;
                log.debug('chargeId', chargeId)

                var amount = requestBody.amount;
                var currency = requestBody.currency;

                if (!chargeId || !amount || !currency) {
                    throw new Error('Missing required refund parameters.');
                }

                var lambdaUrl = 'https://72gdgq3m324tgrzxibnomiu2su0holos.lambda-url.eu-north-1.on.aws'; // Replace with actual Lambda URL

                var payload = {
                    method: 'refund',
                    chargeId: chargeId,
                    amount: amount,
                    currency: currency
                };

                var response = https.post({
                    url: lambdaUrl,
                    body: JSON.stringify(payload),
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                log.debug('Lambda Response', response.body);

                var resBody = JSON.parse(response.body);

                context.response.write(JSON.stringify({
                    status: resBody.status || 'UNKNOWN',
                    refundStatus: resBody.data?.statusDetails?.state || 'UNKNOWN',
                    refundId: resBody.data?.refundId || null,
                    raw: resBody
                }));

            } catch (e) {
                log.error('Error in Amazon Refund Suitelet', e.message);
                context.response.statusCode = 500;
                context.response.write(JSON.stringify({ error: e.message }));
            }
        } else {
            context.response.write('Amazon Pay Refund Suitelet Ready');
        }
    }

    return {
        onRequest: onRequest
    };
});
