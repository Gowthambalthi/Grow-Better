"use strict";

const api = require("./api");
const login = require("./login");

class GrowwProfile {

    async getProfile() {

        const auth = await login.login();

        const token = auth.token;

        const { data } = await api.get(
            "/v1/user/profile",
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "X-API-VERSION": "1.0"
                }
            }
        );

        return data;
    }

}

module.exports = new GrowwProfile();