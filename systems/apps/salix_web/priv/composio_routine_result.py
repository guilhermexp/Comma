import base64
import json
import os
import stat
import zlib


def comma_complete_result(encoded):
    descriptors = []
    try:
        request = json.loads(base64.b64decode(encoded, validate=True))
        path, filename, limit = request['path'], request['filename'], request['limit']
        root = os.path.realpath('/mnt/files')
        resolved = os.path.realpath(path)
        if (root == '/' or not os.path.isabs(path) or '\x00' in path
                or '\\' in path or '://' in path or '..' in path.split('/')
                or filename != os.path.basename(path) or '/' in filename
                or not filename.endswith('.json')
                or os.path.commonpath([root, resolved]) != root):
            raise ValueError()
        parts = os.path.relpath(resolved, root).split('/')
        directory = os.open('/mnt/files', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(directory)
        for part in parts[:-1]:
            directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=directory)
            descriptors.append(directory)
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=directory)
        descriptors.append(descriptor)
        info = os.fstat(descriptor)
        file_limit = limit + 16384
        if not stat.S_ISREG(info.st_mode) or info.st_size > file_limit:
            raise ValueError()
        chunks, size = [], 0
        while size <= file_limit:
            chunk = os.read(descriptor, min(65536, file_limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        if size > file_limit:
            raise ValueError()
        batch = json.loads(b''.join(chunks))
        if 'results' not in batch:
            if batch.get('successful') is False or batch.get('error'):
                raise ValueError()
            batch = batch['data']
        if batch.get('session', {}).get('id', request['session']) != request['session']:
            raise ValueError()
        results = batch['results']
        if not isinstance(results, list) or len(results) != 1:
            raise ValueError()
        result = results[0]
        response = result['response']
        if (result['index'] != 0 or result['tool_slug'] != request['slug']
                or result.get('error') or response.get('successful') is not True
                or 'data_preview' in response or response.get('error')):
            raise ValueError()
        data = response['data']
        if not isinstance(data, dict):
            raise ValueError()
        for wrapper in (batch, response, data):
            if (wrapper.get('truncated') or wrapper.get('has_more')
                    or wrapper.get('nextPageToken')):
                raise ValueError()
        messages = data.get('messages', data.get('data', {}).get('messages', []))
        if not isinstance(messages, list) or len(messages) > 1000:
            raise ValueError()
        raw = json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
        if len(raw) > limit:
            raise ValueError()
        output = json.dumps({'complete': True, 'tool_slug': request['slug'],
                             'encoding': 'zlib-base64', 'raw_bytes': len(raw),
                             'payload': base64.b64encode(zlib.compress(raw)).decode()},
                            separators=(',', ':'))
        if len(output) > limit * 2:
            raise ValueError()
        return output
    except Exception:
        return '{"complete":false}'
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


print(comma_complete_result('__COMMA_REQUEST_BASE64__'))
