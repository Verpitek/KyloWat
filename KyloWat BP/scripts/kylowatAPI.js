import { world, system } from "@minecraft/server"

world.afterEvents.playerPlaceBlock.subscribe(ev => {
    if (!MachineRegistry.has(ev.block.typeId)) return;
    const machine = new Machine(ev.block.typeId, ev.block.location)
    //const network = Network.autoGenerateFromMachine(machine)
    //network.linkAdjacents(machine)
});

world.afterEvents.playerBreakBlock.subscribe(ev => {
    if (!MachineRegistry.has(ev.block.typeId)) return;
    const machine = Machine.reconstructFromId(Machine.findIdByLocation(ev.block.location))
    //Network.removeMachine(machine)
    machine.delete()
});

system.runInterval(() => {
    Network.reconstructAll();

    for (const [id, network] of Network.registry) {
        network.traverseLinkedListJob(machine => {
            if (!machine) return;

            machine.run();

            const nextId = machine.get("next");
            if (nextId) {
                const nextBlock = network.findBlockById(nextId);
                if (nextBlock) {
                    const nextMachine = new Machine(nextBlock);
                    machine.transferEnergy(nextMachine);
                }
            }
        }, 5);
    }
}, 10);

export class Network {
    static registry = new Map();

    constructor(id) {
        this.id = id;
        this.ensureObjective();
        Network.registry.set(id, this);
    }

    /**
     * Auto generate a network starting from a machine
     * Includes all connected machines recursively
     * @param {Machine} machine
     * @returns {Network} 
     */
    static autoGenerateFromMachine(startMachine) {
        const existingNetworkId = startMachine.get("networkId");
        if (existingNetworkId) {
            return Network.registry.get(existingNetworkId) || new Network(existingNetworkId);
        }

        const networkId = makeUUID();
        const network = new Network(networkId);

        const visited = new Set();
        const stack = [startMachine];

        while (stack.length > 0) {
            const current = stack.pop();
            if (visited.has(current.id)) continue;
            visited.add(current.id);

            current.save("networkId", network.id);

            const last = network.get("last");
            if (!last) {
                network.save("head", current.id);
                network.save("last", current.id);
            } else {
                const lastMachine = new Machine(current.block, 0, 0, 0);
                lastMachine.save("next", current.id);
                network.save("last", current.id);
            }

            for (const adj of current.getAdjacents()) {
                if (!visited.has(adj.id)) stack.push(adj);
            }
        }

        return network;
    }

    /**
     * Remove a machine from a network by its ID
     * Updates the linked list and clears the machine's networkId
     * @param {Machine} machine
     */
    static removeMachine(machine) {
        const networkId = machine.get("networkId");
        if (!networkId) return;

        const network = Network.registry.get(networkId);
        if (!network) return;

        let currentId = network.get("head");
        let prevMachine = null;

        while (currentId) {
            const currentBlock = network.findBlockById(currentId);
            if (!currentBlock) break;

            const currentMachine = new Machine(currentBlock, 0, 0, 0);

            if (currentMachine.id === machine.id) {
                if (prevMachine) {
                    prevMachine.save("next", currentMachine.get("next") ?? null);
                } else {
                    network.save("head", currentMachine.get("next") ?? null);
                }

                if (network.get("last") === machine.id) {
                    network.save("last", prevMachine ? prevMachine.id : null);
                }

                machine.save("networkId", null);
                machine.save("next", null);
                break;
            }

            prevMachine = currentMachine;
            currentId = currentMachine.get("next");
        }
    }

    /**
     * Rebuild all networks from the scoreboard
     */
    static reconstructAll() {
        Network.registry.clear();

        for (const obj of world.scoreboard.getObjectives()) {
            if (!obj.id.startsWith("network-")) continue;

            const networkId = obj.id;
            if (!Network.registry.has(networkId)) {
                const net = new Network(networkId);
                Network.registry.set(networkId, net);
            }
        }
    }

    /**
     * Traverse the network linked list using a generator
     * @param {function(Machine):void} callback - Called for each machine
     * @param {number} chunkSize - Machines processed per yield
     */
    traverseNetwork(callback, chunkSize = 1) {
        const network = this;
        const generator = function* () {
            let currentId = network.get("head");

            while (currentId) {
                for (let i = 0; i < chunkSize && currentId; i++) {
                    const block = network.findBlockById(currentId);
                    if (!block) {
                        currentId = null;
                        break;
                    }

                    const machine = new Machine(block);
                    callback(machine);

                    currentId = machine.get("next");
                }
                yield;
            }
        };

        system.runJob(generator());
    }

    /**
     * Ensure the scoreboard for this network exists
     */
    ensureObjective() {
        try {
            world.scoreboard.addObjective(this.id, this.id);
        } catch {}
    }

    /**
     * Save a key/value into this network's scoreboard
     */
    save(key, value) {
        const obj = world.scoreboard.getObjective(this.id);
        obj.setScore(key, value);
    }

    /**
     * Get a value from this network's scoreboard, or null if not set
     */
    get(key) {
        const obj = world.scoreboard.getObjective(this.id);
        try {
            return obj.getScore(key);
        } catch {
            return null;
        }
    }

    /**
     * Register a machine to this network (manual link)
     * @param {Machine} machine
     */
    linkMachine(machine) {
        machine.save("networkId", this.id);

        let last = this.get("last");
        if (!last) {
            this.save("head", machine.id);
            this.save("last", machine.id);
        } else {
            const lastMachine = new Machine(machine.block, 0, 0, 0);
            lastMachine.save("next", machine.id);
            this.save("last", machine.id);
        }
    }

    /**
     * Auto-scan for adjacent machines and link them into this network
     * @param {Machine} machine
     */
    linkAdjacents(machine) {
        for (const adj of machine.getAdjacents()) {
            this.linkMachine(adj);
        }
    }

    /**
     * Retrieve the linked list of machines in this network
     * @returns {Machine[]}
     */
    getMachines() {
        const results = [];
        let currentId = this.get("head");
        while (currentId) {
            const block = this.findBlockById(currentId);
            if (!block) break;

            const machine = new Machine(block, 0, 0, 0);
            results.push(machine);

            currentId = machine.get("next");
        }
        return results;
    }

    /**
     * Permanently delete this network (clear scoreboard)
     */
    delete() {
        world.scoreboard.removeObjective(this.id);
        Network.registry.delete(this.id);
    }
}

/**
 * Represents a registered block ID
 * that has default Machine components
 */
export class MachineRegistry {
    static objectiveId = "machine_registry";
    static cache = new Map();

    static ensureObjective() {
        try {
            world.scoreboard.addObjective(this.objectiveId, "Machine Registry");
        } catch {}
    }

    static register(blockId, energyCost = 0, maxEnergy = 0, startEnergy = 0, transferRate = 50) {
        this.ensureObjective();
        const obj = world.scoreboard.getObjective(this.objectiveId);

        obj.setScore(`${blockId}:energyCost`, energyCost);
        obj.setScore(`${blockId}:maxEnergy`, maxEnergy);
        obj.setScore(`${blockId}:startEnergy`, startEnergy);
        obj.setScore(`${blockId}:transferRate`, transferRate);

        this.cache.set(blockId, { energyCost, maxEnergy, startEnergy, transferRate });
    }

    static get(blockId) {
        if (this.cache.has(blockId)) {
            const cached = this.cache.get(blockId);
            return [cached.energyCost, cached.maxEnergy, cached.startEnergy, cached.transferRate];
        }

        this.ensureObjective();
        const obj = world.scoreboard.getObjective(this.objectiveId);

        const energyCost = obj.getScore(`${blockId}:energyCost`) ?? 0;
        const maxEnergy = obj.getScore(`${blockId}:maxEnergy`) ?? 0;
        const startEnergy = obj.getScore(`${blockId}:startEnergy`) ?? 0;
        const transferRate = obj.getScore(`${blockId}:transferRate`) ?? 50;

        if (!this.has(blockId)) this.register(blockId, energyCost, maxEnergy, startEnergy, transferRate);

        this.cache.set(blockId, { energyCost, maxEnergy, startEnergy, transferRate });

        return [energyCost, maxEnergy, startEnergy, transferRate];
    }

    static has(blockId) {
        if (this.cache.has(blockId)) return true;

        this.ensureObjective();
        const obj = world.scoreboard.getObjective(this.objectiveId);

        try {
            return obj.getScore(`${blockId}:energyCost`) != null;
        } catch {
            return false;
        }
    }
}

/**
 * Represents a single machine tied to a block.
 * A machine has energy, energyCost, and maxEnergy values
 * which are persisted using the scoreboard.
 */
export class Machine {
    static cache = new Map();

    constructor(typeId, location, energyCost = 0, maxEnergy = 0, currentEnergy = 0, transferRate = 50) {
        if (!typeId || !location) throw new Error("Machine requires typeId and location");

        const key = location.x + ":" + location.y + ":" + location.z;

        if (Machine.cache.has(key)) {
            const cached = Machine.cache.get(key);
            if (cached) return cached; 
        }

        const existingId = Machine.findIdByLocation(location);
        if (existingId) {
            const reconstructed = Machine.reconstructFromId(existingId);
            if (reconstructed) {
                Machine.cache.set(key, reconstructed);
                return reconstructed;
            }
        }

        this.id = makeUUID();
        this.ensureObjective();

        this.saveOrInit(typeId, 0)
        this.saveOrInit("x", location.x);
        this.saveOrInit("y", location.y);
        this.saveOrInit("z", location.z);
        this.saveOrInit("energyCost", energyCost);
        this.saveOrInit("maxEnergy", maxEnergy);
        this.saveOrInit("energy", currentEnergy);
        this.saveOrInit("transferRate", transferRate);

        this.energyCost = energyCost;
        this.maxEnergy = maxEnergy;
        this.currentEnergy = currentEnergy;
        this.transferRate = transferRate;

        Machine.cache.set(key, this);
    }

    static findIdByLocation(loc) {
        for (const obj of world.scoreboard.getObjectives()) {
            try {
                const sx = obj.getScore("x");
                const sy = obj.getScore("y");
                const sz = obj.getScore("z");
                if (sx === loc.x && sy === loc.y && sz === loc.z) {
                    return obj.displayName;
                }
            } catch {}
        }
        return null;
    }

    static reconstructFromId(id) {
        const obj = world.scoreboard.getObjective(id);
        if (!obj) return null;

        const x = obj.getScore("x");
        const y = obj.getScore("y");
        const z = obj.getScore("z");
        const energyCost = obj.getScore("energyCost");
        const maxEnergy = obj.getScore("maxEnergy");
        const currentEnergy = obj.getScore("energy");
        const transferRate = obj.getScore("transferRate");
        const key = x + ":" + y + ":" + z;

        if (Machine.cache.has(key)) return Machine.cache.get(key);

        const machine = Object.create(Machine.prototype);
        machine.id = id;
        machine.energyCost = energyCost;
        machine.maxEnergy = maxEnergy;
        machine.currentEnergy = currentEnergy;
        machine.transferRate = transferRate;

        Machine.cache.set(key, machine);
        return machine;
    }

    get typeId() {
        const obj = world.scoreboard.getObjective(this.id);
        if (!obj) return null;

        try {
            const participants = obj.getParticipants();
            for (const p of participants) {
                if (p !== "x" && p !== "y" && p !== "z" && p !== "energyCost" && p !== "maxEnergy" && p !== "energy" && p !== "transferRate") {
                    return p.displayName;
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    get location() {
        return {
            x: this.get("x"),
            y: this.get("y"),
            z: this.get("z")
        };
    }

    getLocationObject() {
        return Object.assign({}, this.location);
    }

    save(name, value) {
        let obj = world.scoreboard.getObjective(this.id);
        if (!obj) obj = world.scoreboard.addObjective(this.id, this.id);
        obj.setScore(name, value);
    }

    get(name) {
        const obj = world.scoreboard.getObjective(this.id);
        if (!obj) return null;
        try {
            return obj.getScore(name);
        } catch {
            return null;
        }
    }

    getOrInit(name, def) {
        const val = this.get(name);
        if (val === null) {
            this.save(name, def);
            return def;
        }
        return val;
    }

    saveOrInit(name, def) {
        if (this.get(name) === null) this.save(name, def);
    }

    ensureObjective() {
        try {
            world.scoreboard.addObjective(this.id, this.id);
        } catch {}
    }

    delete() {
        world.scoreboard.removeObjective(this.id);
        const key = this.location.x + ":" + this.location.y + ":" + this.location.z;
        Machine.cache.delete(key);
        freeUUID(this.id);
    }
}

const uuidObj = "MachineUUIDs"
function makeUUID() {
    let uuid;
    const obj = world.scoreboard.getObjective(uuidObj) ?? world.scoreboard.addObjective(uuidObj, uuidObj);

    do {
        uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    } while (obj.hasParticipant(uuid));

    obj.setScore(uuid, 1);

    return uuid;
}

function freeUUID(uuid) {
    const obj = world.scoreboard.getObjective(uuidObj) ?? world.scoreboard.addObjective(uuidObj, uuidObj);
    if (obj.hasParticipant(uuid)) {
        obj.removeParticipant(uuid);
    }
}
