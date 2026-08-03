"use strict";

const SEGMENT = Object.freeze({
    CASH: "CASH",
    FNO: "FNO",
    CURRENCY: "CURRENCY",
    COMMODITY: "COMMODITY"
});

const EXCHANGE = Object.freeze({
    NSE: "NSE",
    BSE: "BSE",
    MCX: "MCX",
    NCDEX: "NCDEX"
});

const ORDER_TYPE = Object.freeze({
    MARKET: "MARKET",
    LIMIT: "LIMIT",
    SL: "SL",
    SLM: "SLM"
});

const PRODUCT = Object.freeze({
    CNC: "CNC",
    MIS: "MIS",
    NRML: "NRML"
});

const TRANSACTION = Object.freeze({
    BUY: "BUY",
    SELL: "SELL"
});

module.exports = {
    SEGMENT,
    EXCHANGE,
    ORDER_TYPE,
    PRODUCT,
    TRANSACTION
};