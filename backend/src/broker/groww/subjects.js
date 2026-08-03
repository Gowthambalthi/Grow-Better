'use strict';

/*
 * Groww Subject Builder V2
 */

function normalizeExchange(exchange) {

    return String(exchange)
        .trim()
        .toLowerCase();

}

function token(exchangeToken) {

    return String(exchangeToken).trim();

}

/* ---------- MARKET ---------- */

function price(exchange, exchangeToken) {

    exchange = normalizeExchange(exchange);
    exchangeToken = token(exchangeToken);

    return `/ld/eq/${exchange}/price.${exchangeToken}`;

}

function depth(exchange, exchangeToken) {

    exchange = normalizeExchange(exchange);
    exchangeToken = token(exchangeToken);

    return `/ld/eq/${exchange}/book.${exchangeToken}`;

}

function index(exchange, exchangeToken) {

    exchange = normalizeExchange(exchange);
    exchangeToken = token(exchangeToken);

    return `/ld/indices/${exchange}/price.${exchangeToken}`;

}

/* ---------- ORDERS ---------- */

function equityOrders(subscriptionId) {

    return `stocks/order/updates.apex.${subscriptionId}`;

}

function fnoOrders(subscriptionId) {

    return `stocks_fo/order/updates.apex.${subscriptionId}`;

}

function fnoPositions(subscriptionId) {

    return `stocks_fo/position/updates.apex.${subscriptionId}`;

}

/* ---------- DEBUG ---------- */

function debugSubjects(exchange, exchangeToken) {

    exchange = normalizeExchange(exchange);
    exchangeToken = token(exchangeToken);

    return [

        `/ld/eq/${exchange}/price.${exchangeToken}`,

        `ld/eq/${exchange}/price.${exchangeToken}`,

        `/ld/${exchange}/price.${exchangeToken}`,

        `ld/${exchange}/price.${exchangeToken}`,

        `/ld/eq/${exchange}/${exchangeToken}`,

        `ld/eq/${exchange}/${exchangeToken}`,

        `/ld/eq/${exchange}/book.${exchangeToken}`,

        `/ld/indices/${exchange}/price.${exchangeToken}`

    ];

}

module.exports = {

    price,

    depth,

    index,

    equityOrders,

    fnoOrders,

    fnoPositions,

    debugSubjects

};