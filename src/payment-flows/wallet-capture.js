/* @flow */

import { ZalgoPromise } from 'zalgo-promise/src';
import { stringifyError } from 'belter/src';
import { FUNDING } from '@paypal/sdk-constants/src';

import { getSupplementalOrderInfo, exchangeAccessTokenForAuthCode, oneClickApproveOrder } from '../api';
import { BUYER_INTENT } from '../constants';
import { getLogger } from '../lib';

import type { PaymentFlow, PaymentFlowInstance, IsEligibleOptions, IsPaymentEligibleOptions, InitOptions } from './types';
import { checkout } from './checkout';

function setupWalletCapture() {
    // pass
}

function isWalletCaptureEligible({ props, serviceData } : IsEligibleOptions) : boolean {
    const { buyerAccessToken, wallet } = serviceData;
    const { onShippingChange } = props;

    if (!wallet) {
        return false;
    }

    if (!buyerAccessToken) {
        return false;
    }

    if (onShippingChange) {
        return false;
    }

    return true;
}

function isWalletCapturePaymentEligible({ serviceData, payment } : IsPaymentEligibleOptions) : boolean {
    const { wallet } = serviceData;
    const { win, fundingSource, instrumentID } = payment;

    if (fundingSource !== FUNDING.PAYPAL) {
        return false;
    }

    if (win) {
        return false;
    }

    if (!wallet) {
        return false;
    }

    if (!instrumentID) {
        return false;
    }
    
    // $FlowFixMe
    const walletFunding = wallet[fundingSource];

    if (!walletFunding) {
        return false;
    }

    const instrument = walletFunding.instruments.find(inst => inst.instrumentID === instrumentID);
    
    if (!instrument) {
        return false;
    }

    if (!instrument.oneClick) {
        return false;
    }

    if (!instrument.type) {
        return false;
    }

    return true;
}

function initWalletCapture({ props, components, payment, serviceData, config } : InitOptions) : PaymentFlowInstance {
    const { createOrder, onApprove } = props;
    const { fundingSource, instrumentID } = payment;
    const { buyerAccessToken, wallet } = serviceData;

    if (!instrumentID) {
        throw new Error(`Instrument id required for wallet capture`);
    }

    if (!buyerAccessToken) {
        throw new Error(`Buyer access token required for wallet capture`);
    }

    // $FlowFixMe
    const walletFunding = wallet[fundingSource];

    if (!walletFunding) {
        throw new Error(`Expected wallet to be present`);
    }

    const instrument = walletFunding.instruments.find(inst => inst.instrumentID === instrumentID);

    if (!instrument) {
        throw new Error(`Expected instrument to be present`);
    }

    const { type: instrumentType } = instrument;

    if (!instrumentType) {
        throw new Error(`Expected instrumen type`);
    }

    const fallbackToWebCheckout = () => {
        getLogger().info('web_checkout_fallback').flush();
        return exchangeAccessTokenForAuthCode(buyerAccessToken).then(authCode => {
            return checkout.init({ props, components, serviceData, payment: {
                ...payment, authCode, isClick: false, buyerIntent: BUYER_INTENT.PAY_WITH_DIFFERENT_FUNDING_SHIPPING
            }, config }).start();
        });
    };

    const restart = () => {
        return fallbackToWebCheckout();
    };

    const shippingRequired = (orderID) => {
        return getSupplementalOrderInfo(orderID).then(order => {
            const { flags: { isShippingAddressRequired }, cart: { shippingAddress } } = order.checkoutSession;

            if (!isShippingAddressRequired) {
                return false;
            }

            if (shippingAddress && shippingAddress.isFullAddress) {
                return false;
            }

            return true;
        });
    };

    const start = () => {
        return ZalgoPromise.try(() => {
            return createOrder();
        }).then(orderID => {
            return shippingRequired(orderID).then(requireShipping => {
                if (requireShipping) {
                    return fallbackToWebCheckout();
                }

                return oneClickApproveOrder({ orderID, instrumentType, buyerAccessToken, instrumentID })
                    .then(({ payerID }) => {
                        return onApprove({ payerID }, { restart });
                    }, err => {
                        getLogger().warn('approve_order_error', { err: stringifyError(err) }).flush();
                        return fallbackToWebCheckout();
                    });
            });
        });
    };

    return {
        start,
        close: () => ZalgoPromise.resolve()
    };
}

export const walletCapture : PaymentFlow = {
    name:              'wallet_capture',
    setup:             setupWalletCapture,
    isEligible:        isWalletCaptureEligible,
    isPaymentEligible: isWalletCapturePaymentEligible,
    init:              initWalletCapture,
    spinner:           true,
    inline:            true
};