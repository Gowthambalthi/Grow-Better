"use strict";

const axios = require("axios");
const csv = require("csv-parser");
const { Readable } = require("stream");

const cache = require("./instrumentCache");

const URL =
    "https://growwapi-assets.groww.in/instruments/instrument.csv";

const TTL = 24 * 60 * 60 * 1000;

class InstrumentMaster {

    async load() {

        if (
            cache.instruments.length > 0 &&
            (Date.now() - cache.downloadedAt) < TTL
        ) {
            return cache.instruments;
        }

        return this.refresh();
    }

    async refresh() {

        const response = await axios.get(URL);

        const rows = [];

        await new Promise((resolve, reject) => {

            Readable.from(response.data)
                .pipe(csv())
                .on("data", row => rows.push(row))
                .on("end", resolve)
                .on("error", reject);

        });

        cache.instruments = rows;
        cache.downloadedAt = Date.now();

        return rows;
    }

    async getAll() {

        return await this.load();

    }

    async search(query, options = {}) {

        const data = await this.load();

        query = query.toUpperCase();

        return data.filter(row => {

            const matched =
                row.trading_symbol?.toUpperCase().includes(query) ||
                row.groww_symbol?.toUpperCase().includes(query) ||
                row.name?.toUpperCase().includes(query) ||
                row.underlying_symbol?.toUpperCase().includes(query);

            if (!matched)
                return false;

            if (
                options.exchange &&
                row.exchange?.toUpperCase() !== options.exchange.toUpperCase()
            )
                return false;

            if (
                options.segment &&
                row.segment?.toUpperCase() !== options.segment.toUpperCase()
            )
                return false;

            if (
                options.instrumentType &&
                row.instrument_type?.toUpperCase() !== options.instrumentType.toUpperCase()
            )
                return false;

            return true;

        });

    }

    async getBySymbol(symbol) {

        const data = await this.load();

        symbol = symbol.toUpperCase();

        // Exact Trading Symbol
        let instrument = data.find(row =>
            row.trading_symbol?.toUpperCase() === symbol
        );

        if (instrument)
            return instrument;

        // Exact Groww Symbol
        instrument = data.find(row =>
            row.groww_symbol?.toUpperCase() === symbol
        );

        if (instrument)
            return instrument;

        // Exact Company Name
        instrument = data.find(row =>
            row.name?.toUpperCase() === symbol
        );

        if (instrument)
            return instrument;

        // Prefer CASH / EQ instrument
        instrument = data.find(row =>
            row.underlying_symbol?.toUpperCase() === symbol &&
            (
                row.segment?.toUpperCase() === "CASH" ||
                row.segment?.toUpperCase() === "EQ"
            )
        );

        if (instrument)
            return instrument;

        // Fallback to any matching underlying
        instrument = data.find(row =>
            row.underlying_symbol?.toUpperCase() === symbol
        );

        return instrument || null;

    }

    async getByToken(token) {

        const data = await this.load();

        token = String(token);

        return data.find(row =>
            String(row.exchange_token) === token
        ) || null;

    }

    async getByExchange(exchange) {

        const data = await this.load();

        exchange = exchange.toUpperCase();

        return data.filter(row =>
            row.exchange?.toUpperCase() === exchange
        );

    }

    async getBySegment(segment) {

        const data = await this.load();

        segment = segment.toUpperCase();

        return data.filter(row =>
            row.segment?.toUpperCase() === segment
        );

    }

    async getByInstrumentType(type) {

        const data = await this.load();

        type = type.toUpperCase();

        return data.filter(row =>
            row.instrument_type?.toUpperCase() === type
        );

    }

    async getEquity() {

        const data = await this.load();

        return data.filter(row =>
            row.segment === "CASH" ||
            row.segment === "EQ"
        );

    }

    async getFNO() {

        const data = await this.load();

        return data.filter(row =>
            row.segment === "FNO"
        );

    }

    async getCommodity() {

        const data = await this.load();

        return data.filter(row =>
            row.segment === "COMMODITY"
        );

    }

    async stats() {

        const data = await this.load();

        const segments = {};

        for (const row of data) {

            const seg = row.segment || "UNKNOWN";

            segments[seg] = (segments[seg] || 0) + 1;

        }

        return {

            total: data.length,

            segments,

            downloadedAt: new Date(cache.downloadedAt)

        };

    }

}

module.exports = new InstrumentMaster();