/* @flow */

import { extendUrl, uniqueID, getUserAgent, supportsPopups, popup, memoize, stringifyError, PopupOpenError, isIos, isAndroid, isSafari, isChrome } from 'belter/src';
import { ZalgoPromise } from 'zalgo-promise/src';
import { PLATFORM, FUNDING, ENV } from '@paypal/sdk-constants/src';
import { type CrossDomainWindowType, getDomain, isWindowClosed } from 'cross-domain-utils/src';

import type { Props, Components, Config, ServiceData } from '../button/props';
import { NATIVE_CHECKOUT_URI, WEB_CHECKOUT_URI } from '../config';
import { firebaseSocket, type MessageSocket, type FirebaseConfig } from '../api';
import { promiseNoop, getLogger } from '../lib';
import { USER_ACTION } from '../constants';

import type { PaymentFlow, PaymentFlowInstance, Payment } from './types';
import { checkout } from './checkout';

const SOURCE_APP = 'paypal_smart_payment_buttons';
const TARGET_APP = 'paypal_native_checkout';

const MESSAGE = {
    SET_PROPS:  'setProps',
    GET_PROPS:  'getProps',
    CLOSE:      'close',
    FALLBACK:   'fallback',
    ON_APPROVE: 'onApprove',
    ON_CANCEL:  'onCancel',
    ON_ERROR:   'onError'
};

type NativeSocketOptions = {|
    sessionUID : string,
    firebaseConfig : FirebaseConfig,
    version : string
|};

const getNativeSocket = memoize(({ sessionUID, firebaseConfig, version } : NativeSocketOptions) : MessageSocket => {
    return firebaseSocket({
        sessionUID,
        sourceApp:        SOURCE_APP,
        sourceAppVersion: version,
        targetApp:        TARGET_APP,
        config:           firebaseConfig
    });
});

function isNativeOptedIn({ props } : { props : Props }) : boolean {
    const { enableNativeCheckout } = props;

    if (enableNativeCheckout) {
        return true;
    }

    try {
        if (window.localStorage.getItem('__native_checkout__')) {
            return true;
        }
    } catch (err) {
        // pass
    }

    return false;
}

let sessionUID;
let nativeSocket;
let initialPageUrl;

function isNativeEligible({ props, config, serviceData } : { props : Props, config : Config, serviceData : ServiceData }) : boolean {
    
    const { platform, onShippingChange, createBillingAgreement, createSubscription } = props;
    const { firebase: firebaseConfig } = config;
    const { eligibility } = serviceData;

    if (platform !== PLATFORM.MOBILE) {
        return false;
    }

    if (onShippingChange) {
        return false;
    }

    if (createBillingAgreement || createSubscription) {
        return false;
    }

    if (!supportsPopups()) {
        return false;
    }

    if (!firebaseConfig) {
        return false;
    }

    if (isIos()) {
        if (!isSafari()) {
            return false;
        }
    } else if (isAndroid()) {
        if (!isChrome()) {
            return false;
        }
    } else {
        return false;
    }

    if (isNativeOptedIn({ props })) {
        return true;
    }

    return eligibility.native;
}

function isNativePaymentEligible({ payment, props } : { payment : Payment, props : Props }) : boolean {
    const { win, fundingSource } = payment;

    if (win) {
        return false;
    }

    if (fundingSource !== FUNDING.PAYPAL && fundingSource !== FUNDING.VENMO) {
        return false;
    }

    if (!nativeSocket) {
        return false;
    }

    if (fundingSource === FUNDING.VENMO && !isNativeOptedIn({ props })) {
        return false;
    }

    return true;
}

function setupNative({ config, props } : { config : Config, props : Props }) : ZalgoPromise<void> {
    return ZalgoPromise.try(() => {
        const { version, firebase: firebaseConfig } = config;
        const { getPageUrl } = props;

        sessionUID = uniqueID();
        nativeSocket = getNativeSocket({
            sessionUID, firebaseConfig, version
        });

        nativeSocket.onError(err => {
            nativeSocket = null;
            getLogger().error('native_socket_error', { err: stringifyError(err) });
        });

        return getPageUrl().then(pageUrl => {
            initialPageUrl = pageUrl;
        });
    });
}

type NativeSDKProps = {|
    orderID : string,
    facilitatorAccessToken : string,
    pageUrl : string,
    commit : boolean,
    userAgent : string,
    buttonSessionID : string,
    env : $Values<typeof ENV>,
    webCheckoutUrl : string,
    stageHost : ?string,
    apiStageHost : ?string,
    forceEligible : boolean
|};

type AppSwitchPopup = {|
    getWindow : () => CrossDomainWindowType,
    didSwitch : () => boolean,
    close : () => void
|};

function appSwitchPopup(url : string) : AppSwitchPopup {

    let win;
    let appSwitched = false;

    try {
        win = popup(url);
    } catch (err) {
        if (err instanceof PopupOpenError && isIos() && isSafari()) {
            appSwitched = true;
        } else {
            throw err;
        }
    }

    const getWindow = () => win;
    const didSwitch = () => {
        if (appSwitched) {
            return true;
        }

        if (isAndroid() && isChrome() && win && isWindowClosed(win)) {
            return true;
        }

        return false;
    };
    const close = () => {
        if (win) {
            win.close();
        }
    };

    return { getWindow, didSwitch, close };
}

function initNative({ props, components, config, payment, serviceData } : { props : Props, components : Components, config : Config, payment : Payment, serviceData : ServiceData }) : PaymentFlowInstance {
    const { createOrder, onApprove, onCancel, onError, commit, getPageUrl,
        buttonSessionID, env, stageHost, apiStageHost, onClick } = props;
    const { facilitatorAccessToken } = serviceData;
    const { fundingSource } = payment;

    let instance : { close : () => ZalgoPromise<void> } = { close: promiseNoop };

    const fallbackToWebCheckout = ({ win, buyerAccessToken, venmoPayloadID } : { win? : CrossDomainWindowType, buyerAccessToken? : string, venmoPayloadID? : string } = {}) => {
        const checkoutPayment = { ...payment, buyerAccessToken, venmoPayloadID, win, isClick: false };
        instance = checkout.init({ props, components, payment: checkoutPayment, config, serviceData });
        return instance.start();
    };

    const getNativeUrl = () : string => {
        const domain = (fundingSource === FUNDING.VENMO)
            ? 'https://www.paypal.com'
            : getDomain();

        return extendUrl(`${ domain }${ NATIVE_CHECKOUT_URI[fundingSource] }`, {
            query: { sessionUID, buttonSessionID, pageUrl: initialPageUrl }
        });
    };

    const getWebCheckoutFallbackUrl = ({ orderID }) : string => {
        return extendUrl(`${ getDomain() }${ WEB_CHECKOUT_URI }`, {
            query: {
                fundingSource,
                facilitatorAccessToken,
                token:         orderID,
                useraction:    commit ? USER_ACTION.COMMIT : USER_ACTION.CONTINUE,
                native_xo:     '1',
                venmoOverride: (fundingSource === FUNDING.VENMO) ? '1' : '0'
            }
        });
    };

    const getSDKProps = () : ZalgoPromise<NativeSDKProps> => {
        return ZalgoPromise.hash({
            orderID: createOrder(),
            pageUrl: getPageUrl()
        }).then(({ orderID, pageUrl }) => {
            const userAgent = getUserAgent();
            const webCheckoutUrl = getWebCheckoutFallbackUrl({ orderID });
            const forceEligible = isNativeOptedIn({ props });

            return {
                orderID, facilitatorAccessToken, pageUrl, commit, webCheckoutUrl,
                userAgent, buttonSessionID, env, stageHost, apiStageHost, forceEligible
            };
        });
    };

    const connectNative = () => {
        const socket = nativeSocket;

        if (!socket) {
            throw new Error(`Native socket connection not established`);
        }

        socket.on(MESSAGE.GET_PROPS, () : ZalgoPromise<NativeSDKProps> => {
            getLogger().info(`native_message_getprops`).flush();
            return getSDKProps();
        });

        socket.on(MESSAGE.ON_APPROVE, ({ data: { payerID, paymentID, billingToken } }) => {
            getLogger().info(`native_message_onapprove`).flush();
            socket.close();
            const data = { payerID, paymentID, billingToken, isNativeTransaction: true };
            const actions = { restart: () => fallbackToWebCheckout() };
            return onApprove(data, actions);
        });

        socket.on(MESSAGE.ON_CANCEL, () => {
            getLogger().info(`native_message_oncancel`).flush();
            socket.close();
            return onCancel();
        });

        socket.on(MESSAGE.ON_ERROR, ({ data : { message } }) => {
            getLogger().info(`native_message_onerror`, { err: message }).flush();
            socket.close();
            return onError(new Error(message));
        });

        socket.on(MESSAGE.FALLBACK, ({ data: { buyerAccessToken, venmoPayloadID } }) => {
            getLogger().info(`native_message_fallback`).flush();
            socket.close();
            return fallbackToWebCheckout({ buyerAccessToken, venmoPayloadID });
        });

        const setProps = () => {
            return getSDKProps().then(sdkProps => {
                getLogger().info(`native_message_setprops`).flush();
                return socket.send(MESSAGE.SET_PROPS, sdkProps);
            }).then(() => {
                getLogger().info(`native_response_setprops`).flush();
            });
        };

        const closeNative = () => {
            getLogger().info(`native_message_close`).flush();
            return socket.send(MESSAGE.CLOSE).then(() => {
                getLogger().info(`native_response_close`).flush();
                socket.close();
            });
        };

        socket.reconnect();
        
        return { setProps, close: closeNative };
    };

    let appSwitch : AppSwitchPopup;

    const open = () => {
        appSwitch = appSwitchPopup(getNativeUrl());
    };
    
    const close = () => {
        return ZalgoPromise.delay(500).then(() => {
            if (appSwitch.didSwitch()) {
                connectNative().close();
            }

            if (appSwitch) {
                appSwitch.close();
            }
        });
    };

    const click = () => {
        open();

        return ZalgoPromise.try(() => {
            return onClick ? onClick({ fundingSource }) : true;
        }).then(valid => {
            if (!valid) {
                close();
            }
        }, err => {
            close();
            throw err;
        });
    };

    const start = memoize(() => {
        return createOrder().then(() => {
            if (appSwitch.didSwitch()) {
                getLogger().info(`native_app_switch`).flush();
                instance = connectNative();
                return instance.setProps();
            } else {
                getLogger().info(`native_app_web_fallback`).flush();
                return fallbackToWebCheckout({ win: appSwitch.getWindow() });
            }
        }).catch(err => {
            close();
            throw err;
        });
    });


    return {
        click,
        start,
        close: () => instance.close()
    };
}

export const native : PaymentFlow = {
    name:              'native',
    setup:             setupNative,
    isEligible:        isNativeEligible,
    isPaymentEligible: isNativePaymentEligible,
    init:              initNative,
    spinner:           true
};
