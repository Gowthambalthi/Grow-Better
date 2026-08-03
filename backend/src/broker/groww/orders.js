"use strict";

const api = require("./api");
const login = require("./login");

class GrowwOrders {

    async getOrders(options = {}) {

        const {
            segment = "CASH",
            page = 0,
            pageSize = 100
        } = options;

        const auth = await login.login();
        const token = auth.token;

        const { data } = await api.get(
            "/v1/order/list",
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

    async getOrder(growwOrderId, options = {}) {

        const orders = await this.getOrders(options);

        if (
            orders.status !== "SUCCESS" ||
            !orders.payload ||
            !Array.isArray(orders.payload.order_list)
        ) {
            return null;
        }

        return (
            orders.payload.order_list.find(
                order => order.groww_order_id === growwOrderId
            ) || null
        );
    }

}

module.exports = new GrowwOrders();