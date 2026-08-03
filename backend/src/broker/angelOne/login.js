"use strict";

const axios = require("axios");
const speakeasy = require("speakeasy");
const config = require("../config/config");

class AngelLogin {

    constructor() {
        this.session = null;
    }

    async login() {

        if (this.session) {
            return this.session;
        }

        const totp = speakeasy.totp({
            secret: config.angel.totpSecret,
            encoding: "base32"
        });

        const response = await axios.post(
            `${config.angel.baseUrl}/rest/auth/angelbroking/user/v1/loginByPassword`,
            {
                clientcode: config.angel.clientCode,
                password: config.angel.password,
                totp
            },
            {
                headers: {
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

        this.session = response.data;

        return this.session;
    }

    logout() {
        this.session = null;
    }
}

module.exports = new AngelLogin();