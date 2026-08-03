"use strict";

const instrument = require("./instrument");

async function search(exchange, tradingSymbol) {

    exchange = exchange.toUpperCase();
    tradingSymbol = tradingSymbol.toUpperCase();

    const item = await instrument.find(
        exchange,
        tradingSymbol
    );

    if (!item) {

        throw new Error(
            `Instrument not found: ${exchange}:${tradingSymbol}`
        );

    }

    return {

        exchange,

        tradingSymbol,

        symbolToken: item.token,

        instrument: item

    };

}

module.exports = search;