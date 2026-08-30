const ABSOLUTE_THRESHOLDS = Object.freeze({
    hitRate10Floor: 0.8,
    mrr10Floor: 0.6,
    top1RateFloor: 0.5,
    latencyP95CeilingMs: 2000
});

export function evaluateVectorBenchmark({ candidate, baseline = null, overlap10 = null } = {}) {
    if (!candidate) throw new Error('A candidate benchmark result is required');
    const thresholds = baseline ? {
        hitRate10Floor: Math.max(ABSOLUTE_THRESHOLDS.hitRate10Floor, baseline.hitRate10 - 0.02),
        mrr10Floor: Math.max(ABSOLUTE_THRESHOLDS.mrr10Floor, baseline.mrr10 - 0.03),
        top1RateFloor: Math.max(ABSOLUTE_THRESHOLDS.top1RateFloor, baseline.top1Rate - 0.03),
        overlap10Floor: 0.75,
        latencyP95CeilingMs: Math.max(baseline.latencyP95Ms * 1.25, baseline.latencyP95Ms + 50)
    } : { ...ABSOLUTE_THRESHOLDS };

    const passed = candidate.hitRate10 >= thresholds.hitRate10Floor
        && candidate.mrr10 >= thresholds.mrr10Floor
        && candidate.top1Rate >= thresholds.top1RateFloor
        && candidate.latencyP95Ms <= thresholds.latencyP95CeilingMs
        && (!baseline || Number(overlap10) >= thresholds.overlap10Floor);
    return { passed, thresholds };
}

export { ABSOLUTE_THRESHOLDS };
