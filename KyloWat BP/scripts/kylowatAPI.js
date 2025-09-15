import { world, system } from "@minecraft/server";

const UPDATE_TIME = 10

function generateId(block) {
    return `some id`; // TEMP ID SYSTEM: NEED TO CHANGES
}

world.afterEvents.playerPlaceBlock.subscribe(ev => {
    const { block } = ev;
    const id = generateId(block);

    if (Machine.exists(id)) {
        const machine = Machine.getMachine(id);
        if (!machine) return;

        let net = Network.findNetwork(machine);
        if (!net) {
            net = Network.getNetwork(`net_${id}`);
            net.addMachine(machine);
        }

        Network.connectAdjacent(machine, block.location);
    }
});

world.afterEvents.playerBreakBlock.subscribe(ev => {
    const { block } = ev;
    const id = generateId(block);

    if (!Machine.exists(id)) return;

    const machine = Machine.getMachine(id);
    if (!machine) return;

    const net = Network.findNetwork(machine);
    if (net) {
        net.removeMachine(machine);
    }

    machine.delete();
});

system.runInterval(() => {
    Network.runAll()
}, UPDATE_TIME)

/**
 * Represents a network of machines that stores and consumes energy.
 * Within a network, a machine will only run if the previous machine
 * has energy to transmit. Energy cost always applies but can be set to 0.
 */
export class Network {
    static registry = new Set();
    static cache = new Map();

    /** @type {string} */
    id;
    /** @type {Set<Machine>} */
    machines = new Set();
    /** @type {Map<string, string|null>} */
    links = new Map();

    constructor(id) {
        this.id = id;
        this.ensureObjective();
        this.loadLinks();
        Network.cache.set(id, this);
        Network.registry.add(this);
    }

    ensureObjective() {
        try {
            world.scoreboard.addObjective(this.id, `Network ${this.id}`);
        } catch {}
    }

    addMachine(machine) {
        this.machines.add(machine);
        if (!this.links.has(machine.id)) this.links.set(machine.id, null);
        this.saveLinks();
    }

    removeMachine(machine) {
        this.machines.delete(machine);
        this.links.delete(machine.id);

        for (const [a, b] of this.links.entries()) {
            if (b === machine.id) this.links.set(a, null);
        }

        if (this.machines.size === 0) {
            Network.registry.delete(this);
            Network.cache.delete(this.id);
            try {
                world.scoreboard.removeObjective(this.id);
            } catch {}
        } else {
            this.saveLinks();
        }
    }

    link(a, b) {
        if (!this.machines.has(a) || !this.machines.has(b)) return;
        this.links.set(a.id, b.id);
        this.saveLinks();
    }

    unlink(a) {
        if (this.links.has(a.id)) {
            this.links.set(a.id, null);
            this.saveLinks();
        }
    }

    traverse(start) {
        const order = [];
        let current = start.id;
        const visited = new Set();

        while (current && !visited.has(current)) {
            visited.add(current);
            if (!this.links.has(current)) break;

            const machine = Machine.getMachine(current);
            if (!machine) break;
            order.push(machine);

            current = this.links.get(current) ?? null;
        }
        return order;
    }

    transfer(start) {
        const chain = this.traverse(start);
        let i = 0;

        const step = () => {
            if (i >= chain.length) return;
            const machine = chain[i++];
            if (machine.run()) {
                system.runTimeout(step, 1);
            }
        };

        step();
    }

    saveLinks() {
        const obj = world.scoreboard.getObjective(this.id);
        for (const participant of obj.getParticipants()) {
            const name = participant.displayName;
            if (name.includes("->")) {
                obj.removeParticipant(participant);
            }
        }

        for (const [a, b] of this.links.entries()) {
            if (b) obj.setScore(`${a}->${b}`, 1);
        }
    }

    loadLinks() {
        this.links.clear();
        const obj = world.scoreboard.getObjective(this.id);

        for (const participant of obj.getParticipants()) {
            const name = participant.displayName;
            if (name.includes("->")) {
                const [a, b] = name.split("->");
                this.links.set(a, b);
            }
        }
    }

    static connectAdjacent(machine, pos) {
        const offsets = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1],
        ];

        for (const [dx, dy, dz] of offsets) {
            const neighborPos = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
            const neighborId = `some_id`;

            if (Machine.exists(neighborId)) {
                const neighbor = Machine.getMachine(neighborId);
                const network = Network.findNetwork(neighbor);
                const myNetwork = Network.findNetwork(machine);

                if (network && myNetwork && network !== myNetwork) {
                    for (const [id, link] of myNetwork.links) {
                        network.links.set(id, link);
                    }
                    for (const m of myNetwork.machines) {
                        network.machines.add(m);
                    }

                    Network.registry.delete(myNetwork);
                    Network.cache.delete(myNetwork.id);
                } else if (network) {
                    network.addMachine(machine);
                }
            }
        }
    }

    static runAll() {
        for (const net of Network.registry) {
            const firstId = net.links.keys().next().value;
            if (!firstId) continue;
            const start = Machine.getMachine(firstId);
            if (start) net.transfer(start);
        }
    }

    static getNetwork(id) {
        if (Network.cache.has(id)) return Network.cache.get(id);
        return new Network(id);
    }

    static findNetwork(machine) {
        for (const net of Network.registry) {
            if (net.machines.has(machine)) return net;
        }
        return null;
    }
}

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

    // Hard scoreboard limit
    static MIN_VALUE = -2147483647;
    static MAX_VALUE = 2147483647;

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
        if (value > Machine.MAX_VALUE || value < Machine.MIN_VALUE) {
            throw new Error(
                `Scoreboard value for ${name} out of range: ${value} (must be greater than ${Machine.MIN_VALUE} and less than ${Machine.MAX_VALUE})`
            )
        } else {
            const obj = world.scoreboard.getObjective(this.id);
            obj.setScore(name, value);
        }
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
