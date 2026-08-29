import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
});

export function parseAxTable(xml: string, _name: string, _pkg: string) {
  const parsed = parser.parse(xml);
  const root = parsed.AxTable || {};
  
  const fields = (root.Fields?.AxTableField || []).map((f: any) => ({
    name: f.Name,
    type: f['@_xmlns'] ? 'unknown' : 'String', // simplification
    edt: f.ExtendedDataType || '',
    labelId: f.Label || '',
    mandatory: f.Mandatory === 'Yes',
    allowEdit: f.AllowEdit !== 'No'
  }));

  const methods = (root.Methods?.Method || []).map((m: any) => ({
    name: m.Name,
    returnType: m.ReturnType || 'void',
    isStatic: m.IsStatic === 'Yes',
  }));

  return {
    fields,
    methods,
    extends: root.Extends || '',
    saveDataPerCompany: root.SaveDataPerCompany !== 'No',
    properties: root
  };
}

export function parseAxClass(xml: string, _name: string, _pkg: string) {
  const parsed = parser.parse(xml);
  const root = parsed.AxClass || {};
  
  // Basic method parsing from string source - AOT class files store source in <Source>
  const methods: any[] = []; // In a real parser we'd parse X++ here
  
  return {
    methods,
    extends: root.Extends || '',
    implements: root.Implements || '',
    properties: root
  };
}

export function parseAxEnum(xml: string, _name: string, _pkg: string) {
  const parsed = parser.parse(xml);
  const root = parsed.AxEnum || {};
  
  const values = (root.EnumValues?.AxEnumValue || []).map((v: any) => ({
    name: v.Name,
    value: v.Value,
    labelId: v.Label || ''
  }));

  return { values };
}

export function parseAxForm(xml: string, _name: string, _pkg: string) {
  const parsed = parser.parse(xml);
  const root = parsed.AxForm || {};
  
  const dataSources = (root.DataSources?.AxFormDataSource || []).map((ds: any) => ({
    name: ds.Name,
    table: ds.Table || ''
  }));

  const controls = root.Design?.Controls || [];

  return {
    dataSources,
    controls,
    pattern: root.Design?.Pattern || '',
    properties: root
  };
}

export function parseAxQuery(xml: string, _name: string, _pkg: string) {
  const parsed = parser.parse(xml);
  const root = parsed.AxQuery || {};
  
  const dataSources = (root.DataSources?.AxQuerySimpleRootDataSource || []).map((ds: any) => ({
    name: ds.Name,
    table: ds.Table || ''
  }));

  return {
    dataSources,
    properties: root
  };
}

export function parseAxDataEntity(xml: string, _name: string, _pkg: string) {
  const parsed = parser.parse(xml);
  const root = parsed.AxDataEntityView || {};
  
  const fields = (root.Fields?.AxDataEntityViewField || []).map((f: any) => ({
    name: f.Name,
    dataSource: f.DataSource || '',
    dataField: f.DataField || ''
  }));

  return {
    fields,
    stagingTable: root.DataManagementStagingTable || '',
    isPublic: root.IsPublic === 'Yes',
    properties: root
  };
}

export function parseAxEdt(xml: string, _name: string, _pkg: string) {
  const parsed = parser.parse(xml);
  const root = parsed.AxEdt || {};
  
  return {
    extends: root.Extends || '',
    labelId: root.Label || '',
    stringSize: root.StringSize || 0,
    properties: root
  };
}

export function parseLabels(content: string) {
  const labels: { labelId: string, value: string }[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.includes('=')) {
      const [key, ...valueParts] = line.split('=');
      if (key && !key.startsWith(' ')) {
        labels.push({ labelId: key.trim(), value: valueParts.join('=').trim() });
      }
    }
  }
  return labels;
}
