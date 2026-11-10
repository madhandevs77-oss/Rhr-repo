import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { config } from '../server/config.js'
import { connectionOptions } from '../server/db/pool.js'

const URL_RDS = 'postgres://app:pw@mydb.abc.ap-south-1.rds.amazonaws.com:5432/rhr?sslmode=require&application_name=rhr'
const saved = { dbSsl: config.dbSsl, dbSslCaFile: config.dbSslCaFile }
afterEach(() => Object.assign(config, saved))

describe('database TLS options (RDS)', () => {
  test('without explicit settings the connection string is passed through untouched', () => {
    config.dbSsl = undefined; config.dbSslCaFile = ''
    assert.deepEqual(connectionOptions(URL_RDS), { connectionString: URL_RDS })
  })
  test('a CA file turns on verified TLS and strips sslmode so the URL cannot override it', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-')), 'ca.pem')
    fs.writeFileSync(f, '-----BEGIN CERTIFICATE-----\nTESTONLY\n-----END CERTIFICATE-----\n')
    config.dbSsl = undefined; config.dbSslCaFile = f
    const o = connectionOptions(URL_RDS)
    assert.equal(o.ssl.rejectUnauthorized, true)
    assert.match(o.ssl.ca, /TESTONLY/)
    assert.ok(!/sslmode/.test(o.connectionString))
    assert.match(o.connectionString, /application_name=rhr/) // other parameters survive
  })
  test('DATABASE_SSL=false disables TLS even when the URL asks for it; =true verifies certificates', () => {
    config.dbSslCaFile = ''
    config.dbSsl = false
    assert.equal(connectionOptions(URL_RDS).ssl, false)
    config.dbSsl = true
    assert.deepEqual(connectionOptions(URL_RDS).ssl, { rejectUnauthorized: true })
  })
})
