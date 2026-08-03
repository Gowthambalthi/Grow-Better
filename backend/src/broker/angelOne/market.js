"use strict";

const EventEmitter = require("events");

class Market extends EventEmitter {

    constructor(websocket) {

        super();

        this.websocket = websocket;

        this.cache = new Map();

        this.websocket.on(

            "tick",

            tick => this.update(tick)

        );

    }

    update(tick) {

        if (!tick)
            return;

        const token = tick.token;

        if (!token)
            return;

        const previous =

            this.cache.get(token) || {};

        const data = {

            ...previous,

            ...tick,

            updatedAt: Date.now()

        };

        this.cache.set(

            token,

            data

        );

        this.emit(

            "update",

            data

        );

    }

    get(token) {

        return this.cache.get(token) || null;

    }

    getAll() {

        return Array.from(

            this.cache.values()

        );

    }

    has(token) {

        return this.cache.has(token);

    }

    size() {

        return this.cache.size;

    }

    getLTP(token) {

        const data = this.get(token);

        if (!data)
            return null;

        return Number(

            data.last_traded_price

        ) / 100;

    }

    getOpen(token) {

        const data = this.get(token);

        if (!data)
            return null;

        return Number(

            data.open_price_day

        ) / 100;

    }

    getHigh(token) {

        const data = this.get(token);

        if (!data)
            return null;

        return Number(

            data.high_price_day

        ) / 100;

    }

    getLow(token) {

        const data = this.get(token);

        if (!data)
            return null;

        return Number(

            data.low_price_day

        ) / 100;

    }

    getClose(token) {

        const data = this.get(token);

        if (!data)
            return null;

        return Number(

            data.close_price

        ) / 100;

    }

    getVolume(token) {

        const data = this.get(token);

        if (!data)
            return null;

        return Number(

            data.vol_traded

        );

    }

    getBestBid(token) {

        const data = this.get(token);

        if (!data)
            return null;

        if (!data.best_5_buy_data)
            return null;

        if (!data.best_5_buy_data.length)
            return null;

        return {

            price:

                Number(

                    data.best_5_buy_data[0].price

                ) / 100,

            quantity:

                Number(

                    data.best_5_buy_data[0].quantity

                ),

            orders:

                Number(

                    data.best_5_buy_data[0].no_of_orders

                )

        };

    }

    getBestAsk(token) {

        const data = this.get(token);

        if (!data)
            return null;

        if (!data.best_5_sell_data)
            return null;

        if (!data.best_5_sell_data.length)
            return null;

        return {

            price:

                Number(

                    data.best_5_sell_data[0].price

                ) / 100,

            quantity:

                Number(

                    data.best_5_sell_data[0].quantity

                ),

            orders:

                Number(

                    data.best_5_sell_data[0].no_of_orders

                )

        };

    }

    remove(token) {

        this.cache.delete(

            token

        );

    }

    clear() {

        this.cache.clear();

    }

}

module.exports = Market;