// Evolver Operations Module (src/ops/)
// Non-Feishu, portable utilities for evolver lifecycle and maintenance.

module.exports = {
    lifecycle: require('./lifecycle'),
    skillsMonitor: require('./skills_monitor'),
    cleanup: require('./cleanup'),
    trigger: require('./trigger'),
    commentary: require('./commentary'),
    selfRepair: require('./self_repair'),
};
