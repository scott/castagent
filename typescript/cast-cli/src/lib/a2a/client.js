"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.A2AClient = void 0;
const axios_1 = __importDefault(require("axios"));
class A2AClient {
    baseUrl;
    authToken;
    http;
    constructor(baseUrl, authToken) {
        this.baseUrl = baseUrl;
        this.authToken = authToken;
        this.http = axios_1.default.create({
            baseURL: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
            },
        });
    }
    async getAgentCard() {
        const response = await this.http.post('/', {
            jsonrpc: '2.0',
            id: '1',
            method: 'agent/card',
            params: {},
        });
        const data = response.data;
        if (data.error) {
            throw new Error(`A2A error: ${data.error.message}`);
        }
        return data.result;
    }
    async sendMessage(text) {
        const message = {
            role: 'user',
            parts: [{ kind: 'text', text }],
            messageId: this.generateId(),
        };
        const response = await this.http.post('/', {
            jsonrpc: '2.0',
            id: this.generateId(),
            method: 'message/send',
            params: {
                message,
                metadata: {},
            },
        });
        const data = response.data;
        if (data.error) {
            throw new Error(`A2A error: ${data.error.message}`);
        }
        // Extract text from response parts
        const parts = data.result?.parts || [];
        return parts.map((part) => part.text || '').join('');
    }
    generateId() {
        return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
}
exports.A2AClient = A2AClient;
