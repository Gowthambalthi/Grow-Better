"use strict";

const api = require("./api");
const login = require("./login");

class GrowwCancelOrder {

    async cancelOrder(growwOrderId, segment = "CASH") {

        const auth = await login.login();
        const token = auth.token;

        const { data } = await api.post(
            "/v1/order/cancel",
            {
                groww_order_id: growwOrderId,
                segment
            },
            {
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

module.exports = new GrowwCancelOrder();