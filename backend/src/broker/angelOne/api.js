"use strict";

const axios = require("axios");
const config = require("../config/config");

class AngelApi {

    constructor() {
        this.client = axios.create({
            baseURL: config.angel.baseUrl,
            timeout: 30000,
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-PrivateKey": config.angel.apiKey
            }
        });
    }

    async get(url, headers = {}) {
        try {
            const response = await this.client.get(url, { headers });
            return response.data;
        } catch (error) {
            throw this.handleError(error);
        }
    }

    async post(url, data = {}, headers = {}) {
        try {
            const response = await this.client.post(url, data, { headers });
            return response.data;
        } catch (error) {
            throw this.handleError(error);
        }
    }

    async put(url, data = {}, headers = {}) {
        try {
            const response = await this.client.put(url, data, { headers });
            return response.data;
        } catch (error) {
            throw this.handleError(error);
        }
    }

    async delete(url, headers = {}) {
        try {
            const response = await this.client.delete(url, { headers });
            return response.data;
        } catch (error) {
            throw this.handleError(error);
        }
    }

    handleError(error) {
        if (error.response) {
            return new Error(
                `Angel API Error ${error.response.status}: ${
                    error.response.data.message || JSON.stringify(error.response.data)
                }`
            );
        }

        if (error.request) {
            return new Error("Angel API: No response received.");
        }

        return error;
    }

}

module.exports = new AngelApi();