"use strict";

const api = require("./api");
const login = require("./login");

class GrowwTrades {

    async getTrades(growwOrderId, options = {}) {

        const {
            segment = "CASH",
            page = 0,
            pageSize = 50
        } = options;

        const auth = await login.login();

        const token = auth.token;

        const { data } = await api.get(
            `/v1/order/trades/${growwOrderId}`,
            {
                params: {
                    segment,
                    page,
                    page_size: pageSize
                },
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    "X-API-VERSION": "1.0"
                }
            }
        );

        return data;
    }

}

module.exports = new GrowwTrades();