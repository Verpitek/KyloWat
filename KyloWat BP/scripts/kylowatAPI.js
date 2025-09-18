import { world, system } from "@minecraft/server"

world.afterEvents.playerPlaceBlock.subscribe(ev => {
    if (!MachineRegistry.isRegistered(ev.block.typeId)) return;
    const machine = new Machine(ev.block);

    let net = Network.findNetwork(machine);
    if (!net) {
        net = Network.getOrCreate(`net_${machine.id}`);
        net.addMachine(machine);
    }

    Network.connectAdjacent(machine);
});

world.afterEvents.playerBreakBlock.subscribe(ev => {
    if (!MachineRegistry.isRegistered(ev.block.typeId)) return;
    const machine = new Machine(ev.block);
    const net = Network.findNetwork(machine);
    if (net) net.removeMachine(machine);
    machine.delete();
});

system.runInterval(() => {
    Network.runAll();
}, UPDATE_TIME);

export class MachineRegistry {
    /** @type {Map<string, { energyCost: number, maxEnergy: number }>} */
    static registry = new Map();

    /**
     * Register a block as a machine
     * @param {string} blockId - Block typeId (e.g. "minecraft:iron_block")
     * @param {number} energyCost - Energy consumed on run
     * @param {number} maxEnergy - Maximum storable energy
     */
    static register(blockId, energyCost, maxEnergy) {
        this.registry.set(blockId, { energyCost, maxEnergy });
    }

    static isRegistered(blockId) {
        return this.registry.has(blockId);
    }

    static getEnergyCost(blockId) {
        return this.registry.get(blockId)?.energyCost ?? 0;
    }

    static getMaxEnergy(blockId) {
        return this.registry.get(blockId)?.maxEnergy ?? 0;
    }
}

/**
 * Represents a network of connected machines.
 * Networks are formed dynamically by adjacency (neighboring machines).
 * Each network manages a group of machines and can run them together.
 */
export class Network {
    /** @type {Map<string, Network>} All existing networks, keyed by their ID */
    static registry = new Map();

    /**
     * Create a new network
     * @param {string} id - Unique network identifier
     */
    constructor(id) {
        this.id = id;
        /** @type {Set<Machine>} Machines in this network */
        this.machines = new Set();
        Network.registry.set(id, this);
    }

    /**
     * Add a machine to this network
     * @param {Machine} machine
     */
    addMachine(machine) {
        this.machines.add(machine);
    }

    /**
     * Remove a machine from this network
     * If no machines remain, the network is destroyed
     * @param {Machine} machine
     */
    removeMachine(machine) {
        this.machines.delete(machine);
        if (this.machines.size === 0) Network.registry.delete(this.id);
    }

    /**
     * Get an existing network by ID or create a new one
     * @param {string} id - Network ID
     * @returns {Network}
     */
    static getOrCreate(id) {
        return this.registry.get(id) ?? new Network(id);
    }

    /**
     * Find the network that contains a specific machine
     * @param {Machine} machine
     * @returns {Network|null}
     */
    static findNetwork(machine) {
        for (const net of this.registry.values()) {
            if (net.machines.has(machine)) return net;
        }
        return null;
    }

    /**
     * Attempt to connect a machine to any adjacent registered machines
     * - If the neighbor is in a network, merge or add accordingly
     * - If both are in different networks, merge them into one
     * @param {Machine} machine
     */
    static connectAdjacent(machine) {
        const { x, y, z } = machine.block.location;

        // All 6 axis-aligned neighbors
        const offsets = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1],
        ];

        for (const [dx, dy, dz] of offsets) {
            const block = machine.block.dimension.getBlock({ x: x + dx, y: y + dy, z: z + dz });
            if (!block) continue;

            if (MachineRegistry.isRegistered(block.typeId)) {
                const neighbor = new Machine(block);
                const neighborNet = this.findNetwork(neighbor);
                const myNet = this.findNetwork(machine);

                if (neighborNet && myNet && neighborNet !== myNet) {
                    for (const m of myNet.machines) neighborNet.addMachine(m);
                    Network.registry.delete(myNet.id);
                } else if (neighborNet) {
                    neighborNet.addMachine(machine);
                }
            }
        }
    }

    /**
     * Run all machines in this network
     * Machines consume energy when run()
     */
    run() {
        for (const machine of this.machines) {
            machine.run();
        }
    }

    /**
     * Run all networks
     */
    static runAll() {
        for (const net of this.registry.values()) net.run();
    }
}

/**
 * Represents a single machine tied to a block.
 * A machine has energy, energyCost, and maxEnergy values
 * which are persisted using the scoreboard.
 */
export class Machine {
    /**
     * Create or load a machine from a block
     * @param {Block} block - Minecraft block object
     */
    constructor(block) {
        this.block = block;
        this.id = makeMachineId(block);

        const defaults = MachineRegistry.getDefaults(block.typeId);
        if (!defaults) throw new Error(`${block.typeId} not registered`);

        this.ensureObjective();
        this.energyCost    = this.getOrInit("energyCost", defaults.energyCost);
        this.maxEnergy     = this.getOrInit("maxEnergy", defaults.maxEnergy);
        this.currentEnergy = this.getOrInit("energy", 0);
    }

    /**
     * Run the machine once
     * - Consumes energy if enough is available
     * @returns {boolean} true if machine ran, false otherwise
     */
    run() {
        if (this.currentEnergy >= this.energyCost) {
            this.currentEnergy -= this.energyCost;
            this.save("energy", this.currentEnergy);
            return true;
        }
        return false;
    }

    /**
     * Add energy to this machine (clamped to maxEnergy)
     * @param {number} amount
     */
    addEnergy(amount) {
        this.currentEnergy = Math.min(this.currentEnergy + amount, this.maxEnergy);
        this.save("energy", this.currentEnergy);
    }

    /**
     * Save a stat to the scoreboard
     * @param {string} name
     * @param {number} value
     */
    save(name, value) {
        const obj = world.scoreboard.getObjective(this.id);
        obj.setScore(name, value);
    }

    /**
     * Load a stat from the scoreboard
     * If it doesn’t exist, set it to a default value
     * @param {string} name - Stat key
     * @param {number} def - Default value
     * @returns {number}
     */
    getOrInit(name, def) {
        const obj = world.scoreboard.getObjective(this.id);
        try {
            return obj.getScore(name);
        } catch {
            obj.setScore(name, def);
            return def;
        }
    }

    /**
     * Ensure the scoreboard objective exists for this machine
     */
    ensureObjective() {
        try {
            world.scoreboard.addObjective(this.id, `Machine ${this.id}`);
        } catch {}
    }

    /**
     * Permanently delete this machine (remove scoreboard data)
     */
    delete() {
        world.scoreboard.removeObjective(this.id);
    }
}