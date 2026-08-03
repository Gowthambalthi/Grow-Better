"use strict";

const EventEmitter = require("events");

const { WebSocketV2 } = require("smartapi-javascript");

const search = require("./search");

const {
    MODE,
    ACTION,
    EXCHANGE
} = require("./constants");

class AngelWebSocket extends EventEmitter {

    constructor(credentials) {

        super();

        this.credentials = credentials;

        this.socket = null;

        this.connected = false;

        this.subscriptions = new Map();

    }

    async connect() {

        if (this.connected)
            return;

        this.socket = new WebSocketV2({

            clientcode:
                this.credentials.clientCode,

            jwttoken:
                this.credentials.jwtToken,

            apikey:
                this.credentials.apiKey,

            feedtype:
                this.credentials.feedToken

        });

       this.socket.on("tick", tick => {

    console.log("");
    console.log("========== RAW FROM SMARTAPI ==========");
    console.dir(tick, {
        depth: null
    });

    this.emit("tick", tick);

});

        await this.socket.connect();

        this.connected = true;

        this.emit("connected");

    }

    disconnect() {

        if (!this.socket)
            return;

        this.socket.close();

        this.connected = false;

        this.emit("disconnected");

    }

    reconnect(
        type = "simple",
        delay = 5000,
        multiplier = 2
    ) {

        if (!this.socket)
            return;

        this.socket.reconnection(
            type,
            delay,
            multiplier
        );

    }
    async subscribe(

        exchange,

        tradingSymbol,

        mode = MODE.LTP

    ) {

        const result =
            await search(

                exchange,

                tradingSymbol

            );

        const exchangeType =
            EXCHANGE[
                exchange.toUpperCase()
            ];

        if (!exchangeType) {

            throw new Error(
                "Unsupported exchange"
            );

        }

        const request = {

            correlationID:
                `${exchange}:${tradingSymbol}`,

            action:
                ACTION.SUBSCRIBE,

            mode,

            exchangeType,

            tokens: [

                result.symbolToken

            ]

        };

        this.socket.fetchData(
            request
        );

        this.subscriptions.set(

            `${exchange}:${tradingSymbol}`,

            request

        );

        return result;

    }

    async unsubscribe(

        exchange,

        tradingSymbol,

        mode = MODE.LTP

    ) {

        const key =
            `${exchange}:${tradingSymbol}`;

        const data =
            this.subscriptions.get(key);

        if (!data)
            return;

        this.socket.fetchData({

            correlationID:
                key,

            action:
                ACTION.UNSUBSCRIBE,

            mode,

            exchangeType:
                data.exchangeType,

            tokens:
                data.tokens

        });

        this.subscriptions.delete(
            key
        );

    }
    async subscribeMany(

        exchange,

        tradingSymbols,

        mode = MODE.LTP

    ) {

        if (!Array.isArray(tradingSymbols)) {

            throw new Error(
                "tradingSymbols must be an array"
            );

        }

        const exchangeType =
            EXCHANGE[
                exchange.toUpperCase()
            ];

        if (!exchangeType) {

            throw new Error(
                "Unsupported exchange"
            );

        }

        const tokens = [];

        for (const symbol of tradingSymbols) {

            const result =
                await search(
                    exchange,
                    symbol
                );

            tokens.push(
                result.symbolToken
            );

        }

        const request = {

            correlationID:
                `${exchange}:MULTI`,

            action:
                ACTION.SUBSCRIBE,

            mode,

            exchangeType,

            tokens

        };

        this.socket.fetchData(
            request
        );

        tradingSymbols.forEach(

            (symbol, index) => {

                this.subscriptions.set(

                    `${exchange}:${symbol}`,

                    {

                        correlationID:
                            `${exchange}:${symbol}`,

                        action:
                            ACTION.SUBSCRIBE,

                        mode,

                        exchangeType,

                        tokens: [
                            tokens[index]
                        ]

                    }

                );

            }

        );

    }

    unsubscribeAll() {

        for (

            const subscription

            of this.subscriptions.values()

        ) {

            this.socket.fetchData({

                correlationID:
                    subscription.correlationID,

                action:
                    ACTION.UNSUBSCRIBE,

                mode:
                    subscription.mode,

                exchangeType:
                    subscription.exchangeType,

                tokens:
                    subscription.tokens

            });

        }

        this.subscriptions.clear();

    }

    async resubscribe() {

        const list = [

            ...this.subscriptions.values()

        ];

        this.subscriptions.clear();

        for (const item of list) {

            this.socket.fetchData({

                correlationID:
                    item.correlationID,

                action:
                    ACTION.SUBSCRIBE,

                mode:
                    item.mode,

                exchangeType:
                    item.exchangeType,

                tokens:
                    item.tokens

            });

            this.subscriptions.set(

                item.correlationID,

                item

            );

        }

    }

    getSubscriptions() {

        return [

            ...this.subscriptions.keys()

        ];

    }

    isConnected() {

        return this.connected;

    }

}
module.exports = AngelWebSocket;