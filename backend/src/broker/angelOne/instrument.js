"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const URL =
    "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

const CACHE_DIR =
    path.join(__dirname, "cache");

const CACHE_FILE =
    path.join(CACHE_DIR, "instruments.json");

class InstrumentMaster {

    constructor() {

        this.data = [];

        this.loaded = false;

        this.loading = null;

    }

    async load(force = false) {

        if (this.loaded && !force)
            return this.data;

        if (this.loading)
            return this.loading;

        this.loading = this.initialize(force);

        return this.loading;

    }

    async initialize(force) {

        if (!fs.existsSync(CACHE_DIR)) {

            fs.mkdirSync(CACHE_DIR, {
                recursive: true
            });

        }

        if (!force && fs.existsSync(CACHE_FILE)) {

            this.data = JSON.parse(

                fs.readFileSync(
                    CACHE_FILE,
                    "utf8"
                )

            );

            this.loaded = true;

            this.loading = null;

            return this.data;

        }

        const response =
            await axios.get(URL);

        this.data =
            response.data;

        fs.writeFileSync(

            CACHE_FILE,

            JSON.stringify(
                this.data,
                null,
                2
            )

        );

        this.loaded = true;

        this.loading = null;

        return this.data;

    }

    async reload() {

        return this.load(true);

    }

    async all() {

        await this.load();

        return this.data;

    }

    async find(exchange, tradingSymbol) {

        await this.load();

        exchange =
            exchange.toUpperCase();

        tradingSymbol =
            tradingSymbol.toUpperCase();

        return this.data.find(item => {

            if (
                item.exch_seg !== exchange
            )
                return false;

            const symbol =
                (item.symbol || "")
                .toUpperCase();

            const name =
                (item.name || "")
                .toUpperCase();

            if (exchange === "NSE") {

                return (

                    symbol === tradingSymbol ||

                    symbol ===
                    tradingSymbol + "-EQ" ||

                    name === tradingSymbol

                );

            }

            return (

                symbol === tradingSymbol ||

                name === tradingSymbol

            );

        }) || null;

    }

    async token(exchange, tradingSymbol) {

        const instrument =
            await this.find(
                exchange,
                tradingSymbol
            );

        return instrument
            ? instrument.token
            : null;

    }

    async exists(exchange, tradingSymbol) {

        return (

            await this.find(
                exchange,
                tradingSymbol
            )

        ) !== null;

    }

    async byToken(token) {

        await this.load();

        return this.data.find(

            item => item.token == token

        ) || null;

    }

    async search(keyword) {

        await this.load();

        keyword =
            keyword.toUpperCase();

        return this.data.filter(item => {

            const symbol =
                (item.symbol || "")
                .toUpperCase();

            const name =
                (item.name || "")
                .toUpperCase();

            return (

                symbol.includes(keyword) ||

                name.includes(keyword)

            );

        });

    }

}

module.exports =
    new InstrumentMaster();