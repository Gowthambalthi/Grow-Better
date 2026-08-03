"use strict";

const config = require("../config/config");

const loginService = require("./login");
const profileService = require("./profile");
const fundsService = require("./funds");
const holdingsService = require("./holdings");
const positionsService = require("./positions");
const ordersService = require("./orders");
const tradesService = require("./trades");
const quotesService = require("./quotes");

const AngelWebSocket = require("./websocket");
const Market = require("./market");

class AngelBroker {

    constructor() {

        this.session = null;
        this.websocket = null;
        this.market = null;

    }

    async login() {

        this.session = await loginService.login();

        this.websocket = new AngelWebSocket({

            clientCode: config.angel.clientCode,
            apiKey: config.angel.apiKey,

            jwtToken: this.session.data.jwtToken,
            feedToken: this.session.data.feedToken

        });

        this.market = new Market(this.websocket);

        return this.session;

    }

    logout() {

        if (this.websocket)
            this.websocket.disconnect();

        loginService.logout();

        this.session = null;

    }

    async connect() {

        if (!this.websocket)
            throw new Error("Login first.");

        await this.websocket.connect();

    }

    disconnect() {

        if (this.websocket)
            this.websocket.disconnect();

    }

    async subscribe(exchange, symbol) {

        if (!this.websocket)
            throw new Error("Login first.");

        return await this.websocket.subscribe(
            exchange,
            symbol
        );

    }

    async unsubscribe(exchange, symbol) {

        if (!this.websocket)
            return;

        await this.websocket.unsubscribe(
            exchange,
            symbol
        );

    }

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

    async getOrders() {
        return await ordersService.getOrders();
    }

    async getOrder(orderId) {
        return await ordersService.getOrder(orderId);
    }

    async getTrades() {
        return await tradesService.getTrades();
    }

    async getQuote(exchange, tradingSymbol, symbolToken) {

        return await quotesService.getLTP(
            exchange,
            tradingSymbol,
            symbolToken
        );

    }

}

module.exports = AngelBroker;