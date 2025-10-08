import { world, system } from "@minecraft/server"

world.afterEvents.entitySpawn.subscribe(ev => {
    if (!MachineRegistry.has(ev.entity.typeId)) return;
    let cleanLoc = {x: Math.floor(ev.entity.location.x), y: Math.floor(ev.entity.location.y), z: Math.floor(ev.entity.location.z)}
    new Machine(ev.entity.typeId, cleanLoc, ev.entity.dimension.id)
    ev.entity.setDynamicProperty("spawn_location", cleanLoc)
})

world.afterEvents.entityDie.subscribe(ev => {
    if (!MachineRegistry.has(ev.deadEntity.typeId)) return;
    let loc = ev.deadEntity.getDynamicProperty("spawn_location")
    let id = Machine.findIdByLocation(loc, ev.deadEntity.dimension.id)
    if(id){
        Machine.deleteId(id)
    }
})

world.afterEvents.playerPlaceBlock.subscribe(ev => {
    if (!MachineRegistry.has(ev.block.typeId)) return;
    new Machine(ev.block.typeId, {x: ev.block.x, y: ev.block.y, z: ev.block.z}, ev.block.dimension.id)
});

world.afterEvents.playerBreakBlock.subscribe(ev => {
    if (!MachineRegistry.has(ev.brokenBlockPermutation.type.id)) return;
    let id = Machine.findIdByLocation({x: ev.block.x, y: ev.block.y, z: ev.block.z}, ev.dimension.id);
    if(id){
        Machine.deleteId(id)
    }
});

/**
 * Handles energy transfer and machine functionality 
 */
export const EnergySystem = (() => {
    let loopGenerator = null;
    let running = false;
    let intervalTicks = 10;

    function* energyLoop() {
        while (true) {
            const machines = Array.from(Machine.cache.values());

            for (let i = 0; i < machines.length; i++) {
                const machine = machines[i];
                if (!machine) continue;

                machine.transferToLinkedMachines()
                if (i % 25 === 0) yield;
            }

            yield;
        }
    }

    /**
     * Starts the network loop
     * @param {Number} ticks - Update interval in ticks
     * @returns 
     */
    function start(ticks = 10) {
        if (running) return;
        intervalTicks = ticks;
        loopGenerator = energyLoop();
        running = true;

        system.runInterval(() => {
            if (!running || !loopGenerator) return;
            loopGenerator.next();
        }, intervalTicks);
    }

    /**
     * Stops the network loop
     */
    function stop() {
        running = false;
    }

    /**
     * Checks if a network loop is running
     * @returns True/False
     */
    function isRunning() {
        return running;
    }

    /**
     * Changes the network loop interval
     * @param {Number} ticks - New interval in ticks
     */
    function setInterval(ticks) {
        if (typeof ticks === "number" && ticks > 0) {
            intervalTicks = ticks;
            if (running) stop(), start(intervalTicks);
        }
    }

    return { start, stop, isRunning, setInterval };
})();

/**
 * Represents a registered ID
 * that has default Machine components.
 * Block and Entity IDs are handled automatically.
 * Custom IDs will need to be managed yourself
 * and deleted to avoid memory overload.
 */
export class MachineRegistry {
    static objectiveId = "machine_registry";
    static cache = new Map();

    /**
     * Confirms the existing Registry Objective
     */
    static ensureObjective() {
        try {
            world.scoreboard.addObjective(this.objectiveId, "Machine Registry");
        } catch {}
    }

    /**
     * Registers an ID as a machine - automatically handling entities or blocks
     * Custom IDs will not be handled automatically but can be used similarly
     * This will cause all entities or blocks that share the ID to register as a machine on block place or entity spawn
     * @param {String} id - ID to register
     * @param {number} [energyCost=0] - Energy cost per tick
     * @param {number} [maxEnergy=0] - Max energy capacity
     * @param {number} [currentEnergy=0] - Initial energy value
     * @param {number} [transferRate=50] - Default transfer rate
     */
    static register(id, energyCost = 0, maxEnergy = 0, startEnergy = 0, transferRate = 50) {
        this.ensureObjective();
        const obj = world.scoreboard.getObjective(this.objectiveId);

        obj.setScore(`${id}:energyCost`, energyCost);
        obj.setScore(`${id}:maxEnergy`, maxEnergy);
        obj.setScore(`${id}:startEnergy`, startEnergy);
        obj.setScore(`${id}:transferRate`, transferRate);

        this.cache.set(id, { energyCost, maxEnergy, startEnergy, transferRate });
    }

    /**
     * Gets the default values for a registered ID
     * @param {String} id - ID to search
     * @returns - An array of default values [energyCost, maxEnergy, startEnergy, transferRate]
     */
    static get(id) {
        if (this.cache.has(id)) {
            const cached = this.cache.get(id);
            return [cached.energyCost, cached.maxEnergy, cached.startEnergy, cached.transferRate];
        }

        this.ensureObjective();
        const obj = world.scoreboard.getObjective(this.objectiveId);

        const energyCost = obj.getScore(`${id}:energyCost`) ?? 0;
        const maxEnergy = obj.getScore(`${id}:maxEnergy`) ?? 0;
        const startEnergy = obj.getScore(`${id}:startEnergy`) ?? 0;
        const transferRate = obj.getScore(`${id}:transferRate`) ?? 50;

        if (!this.has(id)) this.register(id, energyCost, maxEnergy, startEnergy, transferRate);

        this.cache.set(id, { energyCost, maxEnergy, startEnergy, transferRate });

        return [energyCost, maxEnergy, startEnergy, transferRate];
    }

    /**
     * Checks if the ID is registered
     * @param {String} id  - ID to search
     * @returns True/False
     */
    static has(id) {
        if (this.cache.has(id)) return true;

        this.ensureObjective();
        const obj = world.scoreboard.getObjective(this.objectiveId);

        try {
            return obj.getScore(`${id}:energyCost`) != null;
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

    /**
     * Create or reconstruct a machine
     * Uses x:y:z as key for blocks, or a dynamic property for entities
     * @param {string} typeId - Machine type identifier
     * @param {Object} location - Machine location (x, y, z)
     * @param {String|Number} dim - Machine dimension
     * @param {number} [energyCost=0] - Energy cost per tick
     * @param {number} [maxEnergy=0] - Max energy capacity
     * @param {number} [currentEnergy=0] - Initial energy value
     * @param {number} [transferRate=50] - Default transfer rate
     */
    constructor(typeId, location, dim, energyCost = 0, maxEnergy = 0, currentEnergy = 0, transferRate = 50) {
        if (!typeId || !location) throw new Error("Machine requires typeId and location");

        const key = `${location.x}:${location.y}:${location.z}`;

        if (Machine.cache.has(key)) {
            return Machine.cache.get(key);
        }

        let existingId = Machine.findIdByLocation(location);
        let id = existingId;

        if (id == null) {
            this.id = makeUUID();

            const registryDefaults = MachineRegistry.has(typeId) ? MachineRegistry.get(typeId) : [];
            const [regEnergyCost, regMaxEnergy, regStartEnergy, regTransferRate] = registryDefaults;
            this.energyCost = regEnergyCost !== undefined ? regEnergyCost : energyCost;
            this.maxEnergy = regMaxEnergy !== undefined ? regMaxEnergy : maxEnergy;
            this.currentEnergy = regStartEnergy !== undefined ? regStartEnergy : currentEnergy;
            this.transferRate = regTransferRate !== undefined ? regTransferRate : transferRate;

            if (typeof dim == "string"){
                dim = dimStringToNum(dim)
            }

            const obj = world.scoreboard.addObjective(this.id, this.id);
            obj.setScore("x", location.x);
            obj.setScore("y", location.y);
            obj.setScore("z", location.z);
            obj.setScore("dimension", dim)
            obj.setScore("energyCost", this.energyCost);
            obj.setScore("maxEnergy", this.maxEnergy);
            obj.setScore("energy", this.currentEnergy);
            obj.setScore("transferRate", this.transferRate);

        } else {
            const machine = Machine.reconstructFromId(id);
            this.id = machine.id;
            this.dim = machine.dim
            this.energyCost = machine.energyCost;
            this.maxEnergy = machine.maxEnergy;
            this.currentEnergy = machine.currentEnergy;
            this.transferRate = machine.transferRate;
        }

        Machine.cache.set(key, this);
    }

    /**
     * Find a machine id by its location
     * @param {{x:number, y:number, z:number}} loc - Location to check
     * @param {String|Number} dim - Dim to check
     * @returns {string|null} Machine id or null
     */
    static findIdByLocation(loc, dim) {
        try {
            if (typeof dim == "string"){
                dim = dimStringToNum(dim)
            }
            for (const obj of world.scoreboard.getObjectives()) {
                const sx = obj.getScore("x");
                const sy = obj.getScore("y");
                const sz = obj.getScore("z");
                const sdim = obj.getScore("dimension")
                if (sx === loc.x && sy === loc.y && sz === loc.z && sdim === dim) {
                    return obj.displayName;
                }
            }
        } catch {}
        return null;
    }

    /**
     * Rebuild a machine from a saved id
     * @param {string} id - Machine id
     * @returns {Machine|null} Reconstructed machine or null
     */
    static reconstructFromId(id) {
        const obj = world.scoreboard.getObjective(id) || world.scoreboard.addObjective(id, id);
        if (!obj) return null;

        const x = obj.getScore("x");
        const y = obj.getScore("y");
        const z = obj.getScore("z");
        const dim = obj.getScore("dimension")
        const key = `${x}:${y}:${z}`;

        const energyCost = obj.getScore("energyCost");
        const maxEnergy = obj.getScore("maxEnergy");
        const currentEnergy = obj.getScore("energy");
        const transferRate = obj.getScore("transferRate");

        const machine = Object.create(Machine.prototype);
        machine.id = id;
        machine.dim = dim
        machine.energyCost = energyCost;
        machine.maxEnergy = maxEnergy;
        machine.currentEnergy = currentEnergy;
        machine.transferRate = transferRate;

        Machine.cache.set(key, machine);
        return machine;
    }

    /**
     * Delete a machine from cache and scoreboard by id
     * @param {string} id - Machine id
     */
    static deleteId(id) {
        const obj = world.scoreboard.getObjective(id) || world.scoreboard.addObjective(id, id);
        const key = `${obj.getScore("x")}:${obj.getScore("y")}:${obj.getScore("z")}`;
        Machine.cache.delete(key);
        world.scoreboard.removeObjective(obj)
    }

    /**
     * Run this machine for one tick.
     * Subtracts energyCost acting as if an action was taken,
     * @returns {boolean} True if machine had enough energy to run, false otherwise
     */
    run() {
        if (this.currentEnergy < this.energyCost) return false;

        if (this.energyCost > 0) {
            this.removeEnergy(this.energyCost);
        }

        return true;
    }

    /**
     * Handles transferring energy to all linked machines
     */
    transferToLinkedMachines() {
        const linkedMachines = this.getLinkedMachines();
        for (const target of linkedMachines) {
            if (!target) continue;
            this.transferEnergy(target);
        }
    }

    /**
     * Add energy to this machine
     * Respects maxEnergy and updates scoreboard + cache
     * @param {number} amount - Amount of energy to add
     * @returns {number} Actual amount added
     */
    addEnergy(amount) {
        if (amount <= 0) return 0;

        const availableSpace = this.maxEnergy - this.currentEnergy;
        const added = Math.min(amount, availableSpace);

        if (added > 0) {
            this.currentEnergy += added;
            const obj = world.scoreboard.getObjective(this.id);
            if (obj) obj.setScore("energy", this.currentEnergy);
        }

        return added;
    }

    /**
     * Remove energy from this machine
     * Respects currentEnergy and updates scoreboard + cache
     * @param {number} amount - Amount of energy to remove
     * @returns {number} Actual amount removed
     */
    removeEnergy(amount) {
        if (amount <= 0) return 0;

        const removed = Math.min(amount, this.currentEnergy);

        if (removed > 0) {
            this.currentEnergy -= removed;
            const obj = world.scoreboard.getObjective(this.id);
            if (obj) obj.setScore("energy", this.currentEnergy);
        }

        return removed;
    }

    /**
     * Transfer energy to another machine
     * Respects transferRate, source energy, and target capacity
     * @param {Machine} target - Machine to transfer energy to
     * @param {number} [rate=this.transferRate] - Transfer rate
     * @returns {number} Actual amount transferred
     */
    transferEnergy(target, rate = this.transferRate) {
        if (!target || target.id === this.id) return 0;

        const available = Math.min(rate, this.currentEnergy);
        const capacity = target.maxEnergy - target.currentEnergy;
        const transfer = Math.min(available, capacity);

        if (transfer > 0) {
            this.currentEnergy -= transfer;
            target.currentEnergy += transfer;

            const obj = world.scoreboard.getObjective(this.id);
            const targetObj = world.scoreboard.getObjective(target.id);
            if (obj) obj.setScore("energy", this.currentEnergy);
            if (targetObj) targetObj.setScore("energy", target.currentEnergy);
        }

        return transfer;
    }

    /**
     * Create a link between this machine and another
     * @param {Machine} otherMachine - Machine to link
     * @param {number} [priority=1] - Link priority
     */
    linkMachine(otherMachine, priority = 1) {
        if (!otherMachine || otherMachine.id === this.id) return;
        const obj = world.scoreboard.getObjective(this.id);
        const linkKey = `link:${otherMachine.id}`;
        obj.setScore(linkKey, priority);
    }

    /**
     * Remove a link between this machine and another
     * @param {Machine} otherMachine - Machine to unlink
     */
    unlinkMachine(otherMachine) {
        if (!otherMachine || otherMachine.id === this.id) return;
        const obj = world.scoreboard.getObjective(this.id);
        const linkKey = `link:${otherMachine.id}`;
        obj.removeScore(linkKey);
    }

    /**
     * Get all linked machines
     * @returns {Machine[]} Array of linked machines
     */
    getLinkedMachines() {
        const obj = world.scoreboard.getObjective(this.id);
        const linked = [];
        for (const score of obj.getParticipants()) {
            if (score.displayName.startsWith("link:")) {
                const linkedId = score.displayName.split(":")[1];
                const machine = Machine.reconstructFromId(linkedId);
                if (machine) linked.push(machine);
            }
        }

        return linked;
    }
    
    get location() {
        return {
            x: this.get("x"),
            y: this.get("y"),
            z: this.get("z")
        };
    }

    /**
     * Get a stored scoreboard value
     * @param {string} name - Score name
     * @returns {number|null} Score value or null
     */
    get(name) {
        const obj = world.scoreboard.getObjective(this.id) || world.scoreboard.addObjective(this.id, this.id);
        if (!obj) return null;
        try {
            return obj.getScore(name);
        } catch {
            return null;
        }
    }

    /**
     * Delete this machine from cache and scoreboard
     */
    delete() {
        world.scoreboard.removeObjective(`${this.id}`);
        const key = `${this.location.x}:${this.location.y}:${this.location.z}`;
        Machine.cache.delete(key);
        freeUUID(this.id);
    }
}

function dimStringToNum(dim){
    if (dim.toLowerCase() == "minecraft:overworld"){
        return 0;
    } else if (dim.toLowerCase() == "minecraft:nether"){
        return 1;
    } else if (dim.toLowerCase() == "minecraft:the_end"){
        return 2;
    } else{
        throw `Invalid dimension ID: ${dim}`
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
