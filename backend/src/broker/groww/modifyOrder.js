"use strict";

const api = require("./api");
const login = require("./login");

class GrowwModifyOrder {

    async modifyOrder(order) {

        const auth = await login.login();
        const token = auth.token;

        const { data } = await api.post(
            "/v1/order/modify",
            order,
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

module.exports = new GrowwModifyOrder();