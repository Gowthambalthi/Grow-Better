"use strict";

const speakeasy = require("speakeasy");
const api = require("./api");
const config = require("../config/config");

class GrowwLogin {

    constructor() {
        this.session = null;
    }

    async login() {

        if (this.session) {
            return this.session;
        }

        const otp = speakeasy.totp({
            secret: config.groww.apiSecret,
            encoding: "base32"
        });

        const { data } = await api.post(
            "/v1/token/api/access",
            {
                key_type: "totp",
                totp: otp
            },
            {
                headers: {
                    Authorization: `Bearer ${config.groww.apiKey}`
                }
            }
        );

        this.session = data;

        return this.session;
    }

    logout() {
        this.session = null;
    }
}

module.exports = new GrowwLogin();