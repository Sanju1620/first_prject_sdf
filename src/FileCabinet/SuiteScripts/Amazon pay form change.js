/**
 * @NApiVersion 2.0
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/log'], function (record, log) {

    function beforeSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE) return;

            var SO = context.newRecord;
            var amazonPayRaw = SO.getValue({ fieldId: 'custbody_amznpy_trandetails' });
            log.debug('amazonPayRaw', amazonPayRaw)
            if (!amazonPayRaw) return;

            SO.setValue({
                fieldId: 'customform',
                value: 119, // Set correct custom form ID for Amazon Pay
                ignoreFieldChange: true
            });
            SO.setValue({
                fieldId: 'terms',
                value: '',
                ignoreFieldChange: true
            });

            SO.setValue({
                fieldId: 'paymentmethod',
                value: 26,
                ignoreFieldChange: true
            });
        } catch (e) {
            log.error("Error in beforeSubmit", e.message || e.toString());
        }
    }

    return {
        beforeSubmit: beforeSubmit
    };
});
