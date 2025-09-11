import { world } from "@minecraft/server";

/**
 * Represents a machine that stores and consumes energy.
 * Each machine is persisted using a dedicated scoreboard objective
 * with its own unique ID. Stats like `energy`, `energyCost`, and
 * `maxEnergy` are stored as scoreboard participants.
 */
export class Machine {
    /** @type {string} Unique machine ID */
    id;
    /** @type {number} Amount of energy consumed when run */
    energyCost;
    /** @type {number} Current stored energy */
    currentEnergy;
    /** @type {number} Maximum energy capacity */
    maxEnergy;

    /**
     * Create or load a machine.
     * @param {string} id - Unique machine ID ("machine_10_64_10")
     * @param {number} [energyCost=1] - Default energy cost if machine is new
     * @param {number} [maxEnergy=1] - Default max energy if machine is new
     */
    constructor(id, energyCost = 1, maxEnergy = 1) {
        this.id = id;
        this.ensureObjective();
        this.setStatIfEmpty("energyCost", energyCost);
        this.setStatIfEmpty("maxEnergy", maxEnergy);
        this.energyCost = this.loadStat("energyCost");
        this.maxEnergy = this.loadStat("maxEnergy");
        this.currentEnergy = this.loadStat("energy");
    }

    /**
     * Attempt to run the machine by consuming energy
     * @returns {boolean} True if successful, false if not enough energy
     */
    run() {
        if (this.currentEnergy >= this.energyCost) {
            this.currentEnergy -= this.energyCost;
            this.saveEnergy();
            return true;
        }
        return false;
    }

    /**
     * Save the current energy value to the scoreboard
     */
    saveEnergy() {
        this.setStat("energy", this.currentEnergy);
    }

    /**
     * Add energy to the machine
     * Will not exceed the maxEnergy limit
     * @param {number} amount - Amount of energy to add
     */
    addEnergy(amount) {
        this.currentEnergy = Math.min(this.currentEnergy + amount, this.maxEnergy);
        this.saveEnergy();
    }

    /**
     * Remove energy from the machine
     * Will not drop below 0
     * @param {number} amount - Amount of energy to remove
     */
    removeEnergy(amount) {
        this.currentEnergy = Math.max(this.currentEnergy - amount, 0);
        this.saveEnergy();
    }

    /**
     * Permanently delete this machine by removing its scoreboard objective
     */
    delete() {
        world.scoreboard.removeObjective(this.id);
    }

    /**
     * Ensure the scoreboard objective for this machine exists
     */
    ensureObjective() {
        try {
            world.scoreboard.addObjective(this.id, `Machine ${this.id}`);
        } catch {}
    }

    /**
     * Set a stat value for this machine
     * @param {string} name - Stat name ("energy", "maxEnergy")
     * @param {number} value - Value to set
     */
    setStat(name, value) {
        const obj = world.scoreboard.getObjective(this.id);
        obj.setScore(name, value);
    }

    /**
     * Load a stat value for this machine
     * @param {string} name - Stat name
     * @returns {number} The stored value, or 0 if not set
     */
    loadStat(name) {
        const obj = world.scoreboard.getObjective(this.id);
        try {
            return obj.getScore(name);
        } catch {
            return 0;
        }
    }

    /**
     * Set a stat only if it doesn't already exist
     * @param {string} name - Stat name
     * @param {number} value - Value to set if empty
     */
    setStatIfEmpty(name, value) {
        const obj = world.scoreboard.getObjective(this.id);
        try {
            obj.getScore(name);
        } catch {
            obj.setScore(name, value);
        }
    }

    /**
     * Get all existing machines by scanning scoreboard objectives
     * @returns {Machine[]} An array of Machine instances
     */
    static getAllMachines() {
        return world.scoreboard.getObjectives()
            .map(obj => {
                const id = obj.displayName.replace("Machine ", "") || obj.id;
                return new Machine(id);
            })
            .filter(machine => machine.loadStat("maxEnergy") > 0);
    }

    /**
     * Retrieve an existing machine by ID
     * @param {string} id - Machine ID
     * @returns {Machine|null} The machine instance or null if not found
     */
    static getMachine(id) {
        const obj = world.scoreboard.getObjective(id);
        if (!obj) return null;
        return new Machine(id);
    }

    /**
     * Check if a machine exists by ID
     * @param {string} id - Machine ID
     * @returns {boolean} True if it exists, false otherwise
     */
    static exists(id) {
        return world.scoreboard.getObjectives().some(obj => obj.id === id);
    }
}
