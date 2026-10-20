'use strict'

// Mocha 11 keeps only the last --reporter. This one prints the spec
// reporter and also writes the JSON file from --reporter-option output=.

const fs = require('node:fs')
const path = require('node:path')
const Spec = require('mocha/lib/reporters/spec')
const constants = require('mocha/lib/runner').constants
const inherits = require('mocha/lib/utils').inherits

const EVENT_TEST_END = constants.EVENT_TEST_END
const EVENT_TEST_PASS = constants.EVENT_TEST_PASS
const EVENT_TEST_FAIL = constants.EVENT_TEST_FAIL
const EVENT_TEST_PENDING = constants.EVENT_TEST_PENDING
const EVENT_RUN_END = constants.EVENT_RUN_END

function clean(test) {
  const err = test.err || {}
  return {
    title: test.title,
    fullTitle: typeof test.fullTitle === 'function' ? test.fullTitle() : test.fullTitle,
    file: test.file,
    duration: test.duration,
    currentRetry: typeof test.currentRetry === 'function' ? test.currentRetry() : 0,
    speed: test.speed,
    err: {
      message: err.message,
      stack: err.stack,
    },
  }
}

function SpecAndJson(runner, options) {
  Spec.call(this, runner, options)
  const output = options && options.reporterOption && options.reporterOption.output
  const tests = []
  const pending = []
  const failures = []
  const passes = []

  runner.on(EVENT_TEST_END, test => {
    tests.push(test)
  })
  runner.on(EVENT_TEST_PASS, test => {
    passes.push(test)
  })
  runner.on(EVENT_TEST_FAIL, test => {
    failures.push(test)
  })
  runner.on(EVENT_TEST_PENDING, test => {
    pending.push(test)
  })
  runner.once(EVENT_RUN_END, () => {
    if (!output) return
    const obj = {
      stats: this.stats,
      tests: tests.map(clean),
      pending: pending.map(clean),
      failures: failures.map(clean),
      passes: passes.map(clean),
    }
    fs.mkdirSync(path.dirname(output), {recursive: true})
    fs.writeFileSync(output, JSON.stringify(obj, null, 2))
  })
}

inherits(SpecAndJson, Spec)
SpecAndJson.description = 'spec on the console and JSON in reporter-option output'

module.exports = SpecAndJson
