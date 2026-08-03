"use strict";

const api = require("./api");
const login = require("./login");

class GrowwHoldings {

    async getHoldings() {

        // Get a fresh access token
        const auth = await login.login();

        const token = auth.token;

        const { data } = await api.get(
            "/v1/holdings/user",
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        return data;
    }

}

module.exports = new GrowwHoldings();