'use strict';

const { WebsocketManager } = require('./websocketManager');
const subjects = require('./subjects');

const {
    decodeMarketTick,
    decodeOrderUpdate,
    decodePositionUpdate
} = require('./decoder');

const SUBSCRIPTION_TYPE = {

    PRICE: 'PRICE',
    DEPTH: 'DEPTH',
    INDEX: 'INDEX',

    EQUITY_ORDER_UPDATES: 'EQUITY_ORDER_UPDATES',
    FNO_ORDER_UPDATES: 'FNO_ORDER_UPDATES',
    FNO_POSITION_UPDATES: 'FNO_POSITION_UPDATES'

};

function decoderFor(type) {

    switch (type) {

        case SUBSCRIPTION_TYPE.PRICE:
        case SUBSCRIPTION_TYPE.DEPTH:
        case SUBSCRIPTION_TYPE.INDEX:
            return decodeMarketTick;

        case SUBSCRIPTION_TYPE.EQUITY_ORDER_UPDATES:
        case SUBSCRIPTION_TYPE.FNO_ORDER_UPDATES:
            return decodeOrderUpdate;

        case SUBSCRIPTION_TYPE.FNO_POSITION_UPDATES:
            return decodePositionUpdate;

        default:
            throw new Error(`Unknown subscription type : ${type}`);

    }

}

function subjectFor(type, params, subscriptionId) {

    switch (type) {

        case SUBSCRIPTION_TYPE.PRICE:

            return subjects.price(
                params.exchange,
                params.exchangeToken
            );

        case SUBSCRIPTION_TYPE.DEPTH:

            return subjects.depth(
                params.exchange,
                params.exchangeToken
            );

        case SUBSCRIPTION_TYPE.INDEX:

            return subjects.index(
                params.exchange,
                params.exchangeToken
            );

        case SUBSCRIPTION_TYPE.EQUITY_ORDER_UPDATES:

            return subjects.equityOrders(
                subscriptionId
            );

        case SUBSCRIPTION_TYPE.FNO_ORDER_UPDATES:

            return subjects.fnoOrders(
                subscriptionId
            );

        case SUBSCRIPTION_TYPE.FNO_POSITION_UPDATES:

            return subjects.fnoPositions(
                subscriptionId
            );

        default:

            throw new Error(`Unknown subscription type : ${type}`);

    }

}

class GrowwWebsocket {

    constructor() {

        this.manager = new WebsocketManager();

        this.callbacks = new Map();

    }

    on(event, handler) {

        this.manager.on(event, handler);

        return this;

    }

    async connect() {

        await this.manager.connect();

        return this;

    }

    async disconnect() {

        this.callbacks.clear();

        await this.manager.disconnect();

    }

    async subscribe(type, params = {}) {

        const subscriptionId =
            this.manager.getSubscriptionId();

        if (!subscriptionId) {

            throw new Error(
                "Websocket is not connected."
            );

        }

        const subject =
            subjectFor(
                type,
                params,
                subscriptionId
            );

        console.log("================================");
        console.log("Subscription Type :", type);
        console.log("Subject           :", subject);
        console.log("================================");

        const decode =
            decoderFor(type);

        await this.manager.subscribe(

            subject,

            (msg) => {

                console.log("Message Received");

                let data;

                try {

                    data =
                        decode(msg.data);

                }
                catch (err) {

                    console.error(
                        "Decode Failed"
                    );

                    console.error(err);

                    return;

                }

                const callback =
                    this.callbacks.get(subject);

                if (!callback)
                    return;

                callback(data);

            }

        );

        return {

            subject,

            consume: (callback) => {

                console.log(
                    "Consumer Registered"
                );

                this.callbacks.set(
                    subject,
                    callback
                );

            },

            unsubscribe: () => {

                console.log(
                    "Unsubscribe :",
                    subject
                );

                this.manager.unsubscribe(
                    subject
                );

                this.callbacks.delete(
                    subject
                );

            }

        };

    }

}

module.exports = {

    GrowwWebsocket,

    SUBSCRIPTION_TYPE

};