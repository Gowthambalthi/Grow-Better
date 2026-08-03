"use strict";

const api = require("./api");
const login = require("./login");

class GrowwQuotes {

    async getQuote(exchange, segment, tradingSymbol) {

        const auth = await login.login();

        const token = auth.token;

        try {

            const { data } = await api.get(
                "/v1/live-data/quote",
                {
                    params: {
                        exchange,
                        segment,
                        trading_symbol: tradingSymbol
                    },
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: "application/json",
                        "Content-Type": "application/json",
                        "X-API-VERSION": "1.0"
                    }
                }
            );

            console.log("========== GROWW RESPONSE ==========");
            console.log(JSON.stringify(data, null, 2));

            if (data.status === "FAILURE") {
                throw new Error(JSON.stringify(data.error, null, 2));
            }

            return data;

        } catch (err) {

            console.log("========== ERROR ==========");

            if (err.response) {
                console.log("Status:", err.response.status);
                console.log(JSON.stringify(err.response.data, null, 2));
            } else {
                console.log(err.message);
            }

            throw err;
        }

    }

}

module.exports = new GrowwQuotes();