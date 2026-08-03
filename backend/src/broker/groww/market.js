'use strict';

const { GrowwWebsocket, SUBSCRIPTION_TYPE } = require('./websocket');
const { LiveCache } = require('./cache');

class GrowwMarket {

    constructor() {

        this.ws = new GrowwWebsocket();

        this.cache = new LiveCache();

        this.subscriptions = new Map();

        this.on = (event, handler) => {

            this.ws.on(event, handler);

            return this;

        };

    }

    async connect() {

        console.log("Connecting Market...");

        await this.ws.connect();

        console.log("Market Connected.");

        return this;

    }

    async disconnect() {

        console.log("Disconnecting Market...");

        for (const sub of this.subscriptions.values()) {

            try {

                sub.unsubscribe();

            }
            catch (e) {}

        }

        this.subscriptions.clear();

        await this.ws.disconnect();

    }

    async subscribePrice(params, callback) {

        return this.subscribe(

            SUBSCRIPTION_TYPE.PRICE,

            params,

            callback,

            `PRICE:${params.exchange}:${params.exchangeToken}`

        );

    }

    async subscribeDepth(params, callback) {

        return this.subscribe(

            SUBSCRIPTION_TYPE.DEPTH,

            params,

            callback,

            `DEPTH:${params.exchange}:${params.exchangeToken}`

        );

    }

    async subscribeIndex(params, callback) {

        return this.subscribe(

            SUBSCRIPTION_TYPE.INDEX,

            params,

            callback,

            `INDEX:${params.exchange}:${params.exchangeToken}`

        );

    }

    async subscribeEquityOrderUpdates(callback) {

        return this.subscribe(

            SUBSCRIPTION_TYPE.EQUITY_ORDER_UPDATES,

            {},

            callback,

            "EQUITY_ORDER"

        );

    }

    async subscribeFnoOrderUpdates(callback) {

        return this.subscribe(

            SUBSCRIPTION_TYPE.FNO_ORDER_UPDATES,

            {},

            callback,

            "FNO_ORDER"

        );

    }

    async subscribeFnoPositionUpdates(callback) {

        return this.subscribe(

            SUBSCRIPTION_TYPE.FNO_POSITION_UPDATES,

            {},

            callback,

            "FNO_POSITION"

        );

    }

    async subscribe(type, params, callback, cacheKey) {

        if (this.subscriptions.has(cacheKey)) {

            console.log("Already subscribed:", cacheKey);

            return this.subscriptions.get(cacheKey);

        }

        console.log("==================================");
        console.log("Market Subscribe");
        console.log("Type     :", type);
        console.log("CacheKey :", cacheKey);
        console.log("==================================");

        const handle = await this.ws.subscribe(

            type,

            params

        );

        handle.consume((data) => {

            console.log("Tick Received:", cacheKey);

            this.cache.set(

                cacheKey,

                data

            );

            if (callback) {

                try {

                    callback(data);

                }
                catch (err) {

                    console.error(err);

                }

            }

        });

        const wrapper = {

            cacheKey,

            unsubscribe: () => {

                console.log(

                    "Unsubscribe:",

                    cacheKey

                );

                handle.unsubscribe();

                this.subscriptions.delete(

                    cacheKey

                );

            }

        };

        this.subscriptions.set(

            cacheKey,

            wrapper

        );

        return wrapper;

    }

    getLatest(cacheKey) {

        return this.cache.get(

            cacheKey

        );

    }

    getAllLatest() {

        return this.cache.getAll();

    }

    clearCache() {

        this.cache.clear();

    }

}

module.exports = {

    GrowwMarket,

    SUBSCRIPTION_TYPE

};