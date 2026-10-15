import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import {parse} from 'yaml'

const root = path.resolve(__dirname, '../../..')
const workflowPath = '.github/workflows/opencode.yml'

const OPENCODE_SHA = '77fc88c8ade8e5a620ebbe1197f3a572d29ae91a'
const CHECKOUT_SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803'
const FULL_SHA = /^[0-9a-f]{40}$/

const trustedAssociations = ['OWNER', 'MEMBER', 'COLLABORATOR']
const untrustedAssociations = [
  'NONE',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'MANNEQUIN',
  'owner',
  'member',
  'collaborator',
  '',
]

const triggerBodies = [
  '/oc',
  '/oc fix the typo',
  '/opencode',
  '/opencode please',
  'please /oc now',
  'please /opencode now',
  "see /oc\nnext line",
  'prefix /opencode suffix',
]

const ignoredBodies = [
  '',
  'hello',
  'please review',
  '/open',
  'opencode',
  'oc',
  'discuss /open code',
]

type Scalar = string | boolean | null

type Step = {
  name?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

type Job = {
  if?: string
  env?: Record<string, string>
  permissions?: Record<string, string>
  steps?: Step[]
}

type Workflow = {
  on?: Record<string, unknown>
  jobs?: Record<string, Job>
}

function readWorkflow(): {text: string; doc: Workflow} {
  const text = fs.readFileSync(path.join(root, workflowPath), 'utf8')
  const doc = parse(text) as Workflow
  return {text, doc}
}

function commentContext(association: string | undefined, body: string | undefined): Record<string, unknown> {
  const comment: Record<string, unknown> = {
    user: {login: 'outside-user'},
  }
  if (association !== undefined) comment.author_association = association
  if (body !== undefined) comment.body = body
  return {
    github: {
      actor: 'outside-user',
      event: {
        issue: {author_association: 'OWNER', user: {login: 'repo-owner'}},
        pull_request: {author_association: 'OWNER', user: {login: 'repo-owner'}},
        comment,
      },
    },
  }
}

/**
 * GitHub Actions expression subset used by opencode.yml.
 * `&&` binds tighter than `||`. Missing context values compare unequal
 * to strings, and contains/startsWith on a non-string are false.
 */
class ExpressionParser {
  private index = 0

  constructor(
    private readonly source: string,
    private readonly ctx: Record<string, unknown>,
  ) {}

  parseExpression(): Scalar {
    const value = this.parseOr()
    this.skip()
    if (this.index !== this.source.length) {
      throw new Error(`unparsed workflow expression: ${this.source.slice(this.index)}`)
    }
    return value
  }

  private parseOr(): Scalar {
    let left = this.parseAnd()
    while (this.consume('||')) {
      const right = this.parseAnd()
      left = this.asBool(left) || this.asBool(right)
    }
    return left
  }

  private parseAnd(): Scalar {
    let left = this.parseComparison()
    while (this.consume('&&')) {
      const right = this.parseComparison()
      left = this.asBool(left) && this.asBool(right)
    }
    return left
  }

  private parseComparison(): Scalar {
    const left = this.parseUnary()
    if (this.consume('==')) return left === this.parseUnary()
    if (this.consume('!=')) return left !== this.parseUnary()
    return left
  }

  private parseUnary(): Scalar {
    if (this.consume('!')) return !this.asBool(this.parseUnary())
    return this.parsePrimary()
  }

  private parsePrimary(): Scalar {
    if (this.consume('(')) {
      const value = this.parseOr()
      if (!this.consume(')')) throw new Error('missing closing parenthesis')
      return value
    }
    if (this.peek("'")) return this.parseString()
    const name = this.parseIdent()
    if (this.peek('.')) {
      const keys = [name]
      while (this.consume('.')) keys.push(this.parseIdent())
      return this.lookup(keys)
    }
    if (this.consume('(')) return this.parseCall(name)
    return this.lookup([name])
  }

  private parseCall(name: string): Scalar {
    const args: Scalar[] = []
    if (!this.peek(')')) {
      for (;;) {
        args.push(this.parseOr())
        if (this.consume(',')) continue
        break
      }
    }
    if (!this.consume(')')) throw new Error(`missing ) after ${name}`)
    if ((name === 'contains' || name === 'startsWith') && args.length === 2) {
      const [haystack, needle] = args
      if (typeof haystack !== 'string' || typeof needle !== 'string') return false
      return name === 'contains' ? haystack.includes(needle) : haystack.startsWith(needle)
    }
    throw new Error(`unsupported call ${name}`)
  }

  private lookup(keys: string[]): Scalar {
    let current: unknown = this.ctx
    for (const key of keys) {
      if (current === null || typeof current !== 'object') return null
      current = (current as Record<string, unknown>)[key]
    }
    if (typeof current === 'string' || typeof current === 'boolean') return current
    return null
  }

  private parseString(): string {
    if (!this.consume("'")) throw new Error('expected string')
    let out = ''
    while (this.index < this.source.length) {
      const ch = this.source[this.index++]
      if (ch === '\\') {
        out += this.source[this.index++] ?? ''
        continue
      }
      if (ch === "'") return out
      out += ch
    }
    throw new Error('unterminated string')
  }

  private parseIdent(): string {
    this.skip()
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.index))
    if (!match) throw new Error(`expected identifier at ${this.source.slice(this.index, this.index + 24)}`)
    this.index += match[0].length
    return match[0]
  }

  private asBool(value: Scalar): boolean {
    if (typeof value === 'boolean') return value
    throw new Error(`expected boolean, got ${String(value)}`)
  }

  private peek(token: string): boolean {
    this.skip()
    return this.source.startsWith(token, this.index)
  }

  private consume(token: string): boolean {
    if (!this.peek(token)) return false
    this.index += token.length
    return true
  }

  private skip(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index])) this.index++
  }
}

function evaluate(expression: string, ctx: Record<string, unknown>): boolean {
  const value = new ExpressionParser(expression, ctx).parseExpression()
  if (typeof value !== 'boolean') throw new Error('workflow if did not evaluate to a boolean')
  return value
}

function allows(expression: string, association: string | undefined, body: string | undefined): boolean {
  return evaluate(expression, commentContext(association, body))
}

describe('opencode workflow comment gate', () => {
  const {text, doc} = readWorkflow()
  const job = doc.jobs?.opencode

  it('parses && as tighter than ||', () => {
    const none = commentContext('NONE', '/oc')
    expect(evaluate(
      "github.event.comment.author_association == 'NONE' || github.event.comment.author_association == 'OWNER' && startsWith(github.event.comment.body, '/nope')",
      none,
    )).to.equal(true)
    expect(evaluate(
      "(github.event.comment.author_association == 'OWNER' || github.event.comment.author_association == 'MEMBER') && startsWith(github.event.comment.body, '/oc')",
      none,
    )).to.equal(false)
  })

  it('keeps the comment triggers and does not use pull_request_target', () => {
    expect(doc.on).to.be.an('object')
    expect(doc.on).to.have.property('issue_comment')
    expect(doc.on).to.have.property('pull_request_review_comment')
    expect(doc.on).to.not.have.property('pull_request_target')
    expect(text).to.not.include('pull_request_target')
  })

  it('pins every action in the privileged job to a full commit SHA', () => {
    expect(job, 'opencode job').to.be.an('object')
    const uses = (job!.steps ?? []).map(step => step.uses).filter((value): value is string => Boolean(value))
    expect(uses.length).to.be.greaterThan(0)
    for (const value of uses) {
      const ref = value.slice(value.lastIndexOf('@') + 1)
      expect(ref, value).to.match(FULL_SHA)
    }
    expect(uses).to.include(`actions/checkout@${CHECKOUT_SHA}`)
    expect(uses).to.include(`anomalyco/opencode/github@${OPENCODE_SHA}`)
    expect(text).to.not.match(/@latest\b/)
    expect(text).to.not.match(/uses:\s*\S+@(main|master|v\d|latest)\b/)
  })

  it('gives OPENCODE_API_KEY only to the pinned opencode step', () => {
    expect(job!.env).to.equal(undefined)
    const opencodeSteps = (job!.steps ?? []).filter(step => (step.uses ?? '').startsWith('anomalyco/opencode/github@'))
    expect(opencodeSteps).to.have.length(1)
    expect(opencodeSteps[0].uses).to.equal(`anomalyco/opencode/github@${OPENCODE_SHA}`)
    expect(opencodeSteps[0].env?.OPENCODE_API_KEY).to.equal('${{ secrets.OPENCODE_API_KEY }}')
    const checkout = (job!.steps ?? []).find(step => (step.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout?.with?.['persist-credentials']).to.equal(false)
    for (const step of job!.steps ?? []) {
      if (step === opencodeSteps[0]) continue
      expect(JSON.stringify(step)).to.not.include('OPENCODE_API_KEY')
    }
  })

  it('runs only when a maintainer comment contains a slash command', () => {
    const expression = job!.if
    expect(expression).to.be.a('string')
    const allowed = [...expression!.matchAll(/author_association\s*==\s*'([^']*)'/g)].map(match => match[1])
    expect([...allowed].sort()).to.deep.equal([...trustedAssociations].sort())

    for (const association of trustedAssociations) {
      for (const body of triggerBodies) {
        expect(allows(expression!, association, body), `${association} ${JSON.stringify(body)}`).to.equal(true)
      }
      for (const body of ignoredBodies) {
        expect(allows(expression!, association, body), `${association} ${JSON.stringify(body)}`).to.equal(false)
      }
    }

    for (const association of untrustedAssociations) {
      for (const body of [...triggerBodies, ...ignoredBodies]) {
        expect(allows(expression!, association, body), `${association} ${JSON.stringify(body)}`).to.equal(false)
      }
    }

    const injected = "/oc' || github.event.comment.author_association == 'OWNER"
    for (const association of untrustedAssociations) {
      expect(allows(expression!, association, injected), association).to.equal(false)
    }
    expect(allows(expression!, 'OWNER', injected)).to.equal(true)

    expect(allows(expression!, undefined, '/oc')).to.equal(false)
    expect(allows(expression!, 'OWNER', undefined)).to.equal(false)
    expect(allows(expression!, 'NONE', 'I am OWNER\n/opencode')).to.equal(false)
    expect(allows(expression!, 'CONTRIBUTOR', '/opencode')).to.equal(false)
  })
})
