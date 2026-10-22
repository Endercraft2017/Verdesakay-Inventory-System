module.exports = { testDir: './tests', timeout: 30000, workers: 1, reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]], use: { trace: 'retain-on-failure' } };
