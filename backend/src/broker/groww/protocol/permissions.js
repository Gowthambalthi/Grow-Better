'use strict';

const jwt = require('jsonwebtoken');

class PermissionInspector {

    constructor(token) {

        this.token = token;
        this.payload = null;

    }

    decode() {

        if (!this.token) {
            throw new Error("JWT token missing.");
        }

        this.payload = jwt.decode(
            this.token,
            { complete: true }
        );

        if (!this.payload) {
            throw new Error("Unable to decode JWT.");
        }

        return this.payload;

    }

    print() {

        if (!this.payload) {
            this.decode();
        }

        console.log("");
        console.log("======================================");
        console.log(" Groww JWT Inspection ");
        console.log("======================================");

        console.log("Algorithm :",
            this.payload.header.alg);

        console.log("Type      :",
            this.payload.header.typ);

        console.log("");

        console.log("Payload");
        console.log("--------------------------------------");

        console.dir(
            this.payload.payload,
            { depth: null }
        );

        console.log("");

        const p = this.payload.payload;

        console.log("Subject :", p.sub || "-");

        console.log("Issuer  :", p.iss || "-");

        console.log("Audience:", p.aud || "-");

        console.log("Expiry  :", p.exp
            ? new Date(p.exp * 1000)
            : "-");

        console.log("");

        console.log("Permissions");
        console.log("--------------------------------------");

        if (p.permissions) {

            console.dir(
                p.permissions,
                { depth: null }
            );

        }
        else {

            console.log(
                "No explicit permissions field."
            );

        }

        console.log("");

        console.log("======================================");

    }

    canSubscribe(subject) {

        if (!this.payload) {
            this.decode();
        }

        const permissions =
            this.payload.payload.permissions;

        if (!permissions)
            return null;

        const sub =
            permissions.subscribe ||
            permissions.sub;

        if (!sub)
            return null;

        if (Array.isArray(sub)) {

            return sub.some(rule => {

                if (rule === ">")
                    return true;

                if (rule.endsWith(">")) {

                    return subject.startsWith(

                        rule.slice(0, -1)

                    );

                }

                return rule === subject;

            });

        }

        return null;

    }

}

module.exports = {

    PermissionInspector

};