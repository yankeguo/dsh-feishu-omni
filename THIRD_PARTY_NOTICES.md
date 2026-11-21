# Third-party notices

## @larksuiteoapi/node-sdk

The plugin uses the official Feishu/Lark Node SDK as an unmodified runtime dependency. The SDK is distributed under the MIT license; its license and source are available at <https://github.com/larksuite/node-sdk>.

## axios

HTTP timeout and cancellation use Axios, also distributed under the MIT license. Its license and source are available at <https://github.com/axios/axios>.

## Reference research

The implementation was designed after read-only study of <https://github.com/xmanrui/dsh-im> (MIT). No source file from that project is vendored in this package. DSH's authenticated management-route pattern and the official SDK lifecycle are reimplemented for the different shared-Session model.
