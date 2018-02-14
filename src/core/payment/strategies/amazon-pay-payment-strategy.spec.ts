import { omit } from 'lodash';
import { createClient as createPaymentClient } from 'bigpay-client';
import { AmazonPayScriptLoader } from '../../remote-checkout/methods/amazon-pay';
import { CartActionCreator } from '../../cart';
import { CheckoutClient, CheckoutStore } from '../../checkout';
import { PlaceOrderService } from '../../order';
import { RemoteCheckoutPaymentError, RemoteCheckoutSessionError } from '../../remote-checkout/errors';
import { RemoteCheckoutService } from '../../remote-checkout';
import { RequestError } from '../../common/error/errors';
import { createScriptLoader } from '../../../script-loader';
import { getAmazonPay } from '../../payment/payment-methods.mock';
import { getCart, getCartResponseBody } from '../../cart/carts.mock';
import { getCheckoutMeta } from '../../checkout/checkout.mock';
import { getOrderRequestBody } from '../../order/orders.mock';
import { getResponse, getErrorResponse, getErrorResponseBody } from '../../common/http-request/responses.mock';
import AmazonPayPaymentStrategy from './amazon-pay-payment-strategy';
import PaymentMethod from '../payment-method';
import createCheckoutClient from '../../create-checkout-client';
import createCheckoutStore from '../../create-checkout-store';
import createPlaceOrderService from '../../create-place-order-service';
import createRemoteCheckoutService from '../../create-remote-checkout-service';

describe('AmazonPayPaymentStrategy', () => {
    let client: CheckoutClient;
    let container: HTMLDivElement;
    let scriptLoader: AmazonPayScriptLoader;
    let store: CheckoutStore;
    let strategy: AmazonPayPaymentStrategy;
    let remoteCheckoutService: RemoteCheckoutService;
    let paymentMethod: PaymentMethod;
    let placeOrderService: PlaceOrderService;
    let walletSpy: jest.Mock;

    class Wallet implements OffAmazonPayments.Widgets.Wallet {
        constructor(public options: OffAmazonPayments.Widgets.WalletOptions) {
            walletSpy(options);
        }

        bind(id: string) {
            const element = document.getElementById(id);

            element.addEventListener('paymentSelect', () => {
                this.options.onPaymentSelect({
                    getAmazonOrderReferenceId: () => getCheckoutMeta().remoteCheckout.amazon.referenceId,
                });
            });

            element.addEventListener('error', (event: CustomEvent) => {
                this.options.onError(Object.assign(new Error(), {
                    getErrorCode: () => event.detail.code,
                }));
            });
        }
    }

    beforeEach(() => {
        container = document.createElement('div');
        client = createCheckoutClient();
        store = createCheckoutStore();
        placeOrderService = createPlaceOrderService(store, client, createPaymentClient());
        remoteCheckoutService = createRemoteCheckoutService(store, client);
        paymentMethod = getAmazonPay();
        scriptLoader = new AmazonPayScriptLoader(createScriptLoader());
        strategy = new AmazonPayPaymentStrategy(paymentMethod,
            store,
            placeOrderService,
            remoteCheckoutService,
            scriptLoader
        );
        walletSpy = jest.fn();

        container.setAttribute('id', 'wallet');
        document.body.appendChild(container);

        jest.spyOn(scriptLoader, 'loadWidget').mockImplementation(() => {
            (window as any).OffAmazonPayments = { Widgets: { Wallet } };
            (window as any).onAmazonPaymentsReady();

            return Promise.resolve();
        });

        jest.spyOn(client, 'loadCart')
            .mockReturnValue(Promise.resolve(getResponse(getCartResponseBody())));

        jest.spyOn(remoteCheckoutService, 'initializePayment')
            .mockReturnValue(Promise.resolve(store.getState()));

        jest.spyOn(remoteCheckoutService, 'synchronizeBillingAddress')
            .mockReturnValue(Promise.resolve(store.getState()));

        jest.spyOn(placeOrderService, 'submitOrder')
            .mockReturnValue(Promise.resolve(store.getState()));

        remoteCheckoutService.setCheckoutMeta('amazon', getCheckoutMeta().remoteCheckout.amazon);
    });

    afterEach(() => {
        document.body.removeChild(container);
    });

    it('loads widget script', async () => {
        await strategy.initialize({ container: 'wallet' });

        expect(scriptLoader.loadWidget).toHaveBeenCalledWith(paymentMethod);
    });

    it('initializes payment when selecting new payment method', async () => {
        await strategy.initialize({ container: 'wallet' });

        document.getElementById('wallet').dispatchEvent(new CustomEvent('paymentSelect'));

        expect(remoteCheckoutService.initializePayment)
            .toHaveBeenCalledWith(paymentMethod.id, getCheckoutMeta().remoteCheckout.amazon);
    });

    it('synchronizes address when selecting new payment method', async () => {
        await strategy.initialize({ container: 'wallet' });

        document.getElementById('wallet').dispatchEvent(new CustomEvent('paymentSelect'));

        await new Promise((resolve) => process.nextTick(resolve));

        expect(remoteCheckoutService.initializePayment).toHaveBeenCalled();

        expect(remoteCheckoutService.synchronizeBillingAddress)
            .toHaveBeenCalledWith(paymentMethod.id, getCheckoutMeta().remoteCheckout.amazon);
    });

    it('passes error to callback when wallet widget encounters error', async () => {
        const onError = jest.fn();
        const element = document.getElementById('wallet');

        await strategy.initialize({ container: 'wallet', onError });

        element.dispatchEvent(new CustomEvent('error', { detail: { code: 'BuyerSessionExpired' } }));
        expect(onError).toHaveBeenCalledWith(expect.any(RemoteCheckoutSessionError));

        element.dispatchEvent(new CustomEvent('error', { detail: { code: 'PeriodicAmountExceeded' } }));
        expect(onError).toHaveBeenCalledWith(expect.any(RemoteCheckoutPaymentError));
    });

    it('reinitializes payment method when cart total changes', async () => {
        await strategy.initialize({ container: 'wallet' });
        await store.dispatch(new CartActionCreator(client).loadCart());

        expect(remoteCheckoutService.initializePayment)
            .toHaveBeenCalledWith(paymentMethod.id, getCheckoutMeta().remoteCheckout.amazon);

        expect(remoteCheckoutService.initializePayment).toHaveBeenCalledTimes(2);
    });

    it('does not reinitialize payment method if cart total remains the same', async () => {
        await store.dispatch(new CartActionCreator(client).loadCart());
        await strategy.initialize({ container: 'wallet' });
        await store.dispatch(new CartActionCreator(client).loadCart());

        expect(remoteCheckoutService.initializePayment).toHaveBeenCalledTimes(1);
    });

    it('reinitializes payment method before submitting order', async () => {
        const payload = getOrderRequestBody();
        const options = {};

        await strategy.initialize({ container: 'wallet' });
        await strategy.execute(payload, options);

        expect(remoteCheckoutService.initializePayment)
            .toHaveBeenCalledWith('amazon', getCheckoutMeta().remoteCheckout.amazon);

        expect(placeOrderService.submitOrder)
            .toHaveBeenCalledWith({
                ...payload,
                payment: omit(payload.payment, 'paymentData'),
            }, options);
    });

    it('refreshes wallet when there is provider widget error', async () => {
        jest.spyOn(placeOrderService, 'submitOrder')
            .mockReturnValue(Promise.reject(
                new RequestError(getErrorResponse({ type: 'provider_widget_error' }))
            ));

        await strategy.initialize({ container: 'wallet' });

        walletSpy.mockReset();

        try {
            await strategy.execute(getOrderRequestBody());
        } catch (error) {
            expect(walletSpy).toHaveBeenCalled();
        }
    });

    it('returns error response if order submission fails', async () => {
        const expected = new RequestError(getErrorResponse());

        jest.spyOn(placeOrderService, 'submitOrder')
            .mockReturnValue(Promise.reject(expected));

        await strategy.initialize({ container: 'wallet' });

        try {
            await strategy.execute(getOrderRequestBody());
        } catch (error) {
            expect(error).toEqual(expected);
        }
    });
});