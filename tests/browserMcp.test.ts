import { expect, it } from 'vitest';
import {
  browserClientMessage,
  filterBrowserTools,
} from '../src/core/runtimes/browserMcp';
it('forces an isolated workspace and filters host code, file uploads, file names and metadata', () => {
  const init = browserClientMessage({
    id: 1,
    method: 'initialize',
    params: { capabilities: { roots: { listChanged: true }, sampling: {} } },
  });
  expect(init.forward).toMatchObject({ params: { capabilities: {} } });
  expect(
    browserClientMessage({
      id: 2,
      method: 'tools/call',
      params: { name: 'browser_run_code', arguments: { code: 'read files' } },
    }).error,
  ).toMatch(/disabled/);
  expect(
    browserClientMessage({
      id: 2,
      method: 'tools/call',
      params: { name: 'browser_file_upload', arguments: { paths: ['secret'] } },
    }).error,
  ).toMatch(/disabled/);
  expect(
    browserClientMessage({
      id: 2,
      method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: { filename: 'outside' } },
    }).error,
  ).toMatch(/files/);
  expect(
    browserClientMessage({
      id: 2,
      method: 'tools/call',
      params: {
        name: 'browser_navigate',
        arguments: { url: 'file:///secret' },
      },
    }).error,
  ).toMatch(/http/);
  expect(
    browserClientMessage({
      id: 2,
      method: 'tools/call',
      params: {
        name: 'browser_evaluate',
        arguments: { function: '()=>1', _meta: { cwd: 'C:/Vault' } },
      },
    }).forward,
  ).toEqual({
    id: 2,
    method: 'tools/call',
    params: { name: 'browser_evaluate', arguments: { function: '()=>1' } },
  });
  expect(
    filterBrowserTools([
      { name: 'browser_navigate' },
      { name: 'browser_run_code' },
      { name: 'secret_tool' },
    ]),
  ).toEqual([{ name: 'browser_navigate' }]);
});
