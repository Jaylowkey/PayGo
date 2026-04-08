// js/circuit-breaker.js

export class CircuitBreaker {
    constructor(requestFunction, options = {}) {
        this.requestFunction = requestFunction;
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.failureThreshold = options.failureThreshold || 3;
        this.resetTimeout = options.resetTimeout || 60000;
        this.nextAttempt = Date.now();
        this.serviceName = options.serviceName || 'API_Externa';
    }

    async fire(...args) {
        if (this.state === 'OPEN') {
            if (Date.now() > this.nextAttempt) {
                this.state = 'HALF_OPEN';
                console.log(`[CIRCUIT BREAKER] 🔄 Testando reabertura: ${this.serviceName}`);
            } else {
                const tempoRestante = Math.ceil((this.nextAttempt - Date.now()) / 1000);
                throw new Error(`CIRCUITO_ABERTO:${tempoRestante}`);
            }
        }

        try {
            const response = await this.requestFunction(...args);
            return this.success(response);
        } catch (error) {
            return this.fail(error);
        }
    }

    success(response) {
        this.failureCount = 0;
        this.state = 'CLOSED';
        return response;
    }

    fail(error) {
        this.failureCount++;
        console.warn(`[CIRCUIT BREAKER] ⚠️ Falha em ${this.serviceName} (${this.failureCount}/${this.failureThreshold})`);

        if (this.failureCount >= this.failureThreshold && this.state !== 'OPEN') {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.resetTimeout;
            console.error(`[CIRCUIT BREAKER] 🚨 CIRCUITO ABERTO! ${this.serviceName} isolado.`);
            
            // Aqui podes disparar um alerta silencioso para a tua API /api/log-action
            fetch('/api/log-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    adminId: 'system', action: 'CIRCUIT_BREAKER_TRIPPED', targetId: this.serviceName, newData: { error: error.message }
                })
            }).catch(()=>{});
        }
        throw error;
    }
}
