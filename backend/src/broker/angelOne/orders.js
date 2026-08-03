"use strict";

const axios = require("axios");
const config = require("../config/config");
const login = require("./login");

class AngelOrders {

    async getOrders() {

        const auth = await login.login();

        const jwtToken = auth.data.jwtToken;

        const response = await axios.get(
            `${config.angel.baseUrl}/rest/secure/angelbroking/order/v1/getOrderBook`,
            {
                headers: {
                    Authorization: `Bearer ${jwtToken}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "X-PrivateKey": config.angel.apiKey,
                    "X-SourceID": "WEB",
                    "X-UserType": "USER",
                    "X-ClientLocalIP": "127.0.0.1",
                    "X-ClientPublicIP": "127.0.0.1",
                    "X-MACAddress": "00:00:00:00:00:00",
                    "User-Agent": "Mozilla/5.0"
                }
            }
        );

        return response.data;
    }

    async getOrder(orderId) {

        const orders = await this.getOrders();

        if (!orders.status || !Array.isArray(orders.data)) {
            return null;
        }

        return (
            orders.data.find(
                order => order.orderid === orderId
            ) || null
        );
    }

}

module.exports = new AngelOrders();