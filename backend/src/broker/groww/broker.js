"use strict";

const { GrowwMarket } = require("./market");

const market = new GrowwMarket();

const instrument = require("./instrumentMaster");

const loginService = require("./login");

const profileService = require("./profile");

const fundsService = require("./funds");

const holdingsService = require("./holdings");

const positionsService = require("./positions");

const ordersService = require("./orders");

const tradesService = require("./trades");

const quotesService = require("./quotes");

const placeOrderService = require("./placeOrder");

const modifyOrderService = require("./modifyOrder");

const cancelOrderService = require("./cancelOrder");

class GrowwBroker {

    /* ============================================================
                            AUTH
    ============================================================ */

    async login() {

        return await loginService.login();

    }

    async logout() {

        if (typeof loginService.logout === "function") {

            return await loginService.logout();

        }

        return true;

    }

    /* ============================================================
                            ACCOUNT
    ============================================================ */

    async getProfile() {

        return await profileService.getProfile();

    }

    async getFunds() {

        return await fundsService.getFunds();

    }

    async getHoldings() {

        return await holdingsService.getHoldings();

    }

    async getPositions() {

        return await positionsService.getPositions();

    }

    /* ============================================================
                            ORDERS
    ============================================================ */

    async getOrders(options = {}) {

        return await ordersService.getOrders(options);

    }

    async getOrder(orderId, options = {}) {

        return await ordersService.getOrder(
            orderId,
            options
        );

    }

    async getTrades(orderId, options = {}) {

        return await tradesService.getTrades(
            orderId,
            options
        );

    }

    async placeOrder(order) {

        return await placeOrderService.placeOrder(order);

    }

    async modifyOrder(order) {

        return await modifyOrderService.modifyOrder(order);

    }

    async cancelOrder(growwOrderId, segment = "CASH") {

        return await cancelOrderService.cancelOrder(
            growwOrderId,
            segment
        );

    }

    /* ============================================================
                        INSTRUMENT MASTER
    ============================================================ */

    async search(query) {

        return await instrument.search(query);

    }

    async getInstrument(symbol) {

        return await instrument.getBySymbol(symbol);

    }

    async getInstrumentByToken(token) {

        return await instrument.getByToken(token);

    }

    async getAllInstruments() {

        return await instrument.getAll();

    }

    async refreshInstrumentMaster() {

        return await instrument.refresh();

    }

    async getInstrumentsByExchange(exchange) {

        return await instrument.getByExchange(exchange);

    }

    async getInstrumentsBySegment(segment) {

        return await instrument.getBySegment(segment);

    }

    /* ============================================================
                            QUOTES
    ============================================================ */

    async getQuote(exchange, segment, tradingSymbol) {

        return await quotesService.getQuote(

            exchange,

            segment,

            tradingSymbol

        );

    }

    /* ============================================================
                        MARKET (Native Methods)
    ============================================================ */

    async connectMarket() {

        return market.connect();

    }

    async disconnectMarket() {

        return market.disconnect();

    }

    async subscribePrice(exchange, exchangeToken) {

        return market.subscribePrice(

            exchange,

            exchangeToken

        );

    }

    async subscribeDepth(exchange, exchangeToken) {

        return market.subscribeDepth(

            exchange,

            exchangeToken

        );

    }

    async unsubscribe(subject) {

        return market.unsubscribe(subject);

    }

    onTick(callback) {

        return market.onTick(callback);

    }

    onOrderUpdate(callback) {

        return market.onOrderUpdate(callback);

    }

    onPositionUpdate(callback) {

        return market.onPositionUpdate(callback);

    }

    getLivePrice(token) {

        return market.getPrice(token);

    }

    /* ============================================================
                UNIVERSAL BROKER INTERFACE
    ============================================================ */

    async connect() {

        return this.connectMarket();

    }

    async disconnect() {

        return this.disconnectMarket();

    }

    async subscribe(type, params = {}) {

        switch (String(type).toUpperCase()) {

            case "PRICE":

                return this.subscribePrice(

                    params.exchange,

                    params.exchangeToken

                );

            case "DEPTH":

                return this.subscribeDepth(

                    params.exchange,

                    params.exchangeToken

                );

            default:

                throw new Error(

                    `Unsupported subscription type: ${type}`

                );

        }

    }

}

module.exports = GrowwBroker;