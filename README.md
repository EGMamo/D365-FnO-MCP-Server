# D365 FnO MCP Server

An MCP server for Dynamics 365 Finance & Operations developers, providing tools to search AOT, get metadata, and generate X++ code.

## Prerequisites
- Node.js 22 or higher

## Setup

1. Clone repository
2. Copy `.env.example` to `.env` and set your `D365_PACKAGES_DIR` and `MCP_API_KEY`.
3. Install dependencies: `npm install`
4. Build project: `npm run build`
5. Start server: `npm start`

## Tools Provided
- search_symbols
- get_table_schema
- get_class_hierarchy
- get_method_signature
- find_references
- get_enum_values
- get_edt_details
- get_form_datasources
- get_element_xml
- list_objects
- get_index_stats
- resolve_label
- search_labels
- create_coc_extension
- create_table_extension
- create_class_extension
- generate_xpp_class
- create_runbase_batch
- create_sys_operation

## Client Config
Use HTTP SSE with your chosen MCP client, pointing to `http://localhost:3000/sse` and providing `x-api-key` header.
