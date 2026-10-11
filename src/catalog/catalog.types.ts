export type BayTypeKind = 'required' | 'preferred';

export interface RequiredSkillRef {
  skillCode: string;
  minProficiency: number;
}

export interface BayTypeRef {
  bayTypeCode: string;
  kind: BayTypeKind;
}

/** A service type with its duration, buffer, required skills, and bay-type rules. */
export interface ServiceTypeDetail {
  id: string;
  code: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  requiredSkills: RequiredSkillRef[];
  bayTypes: BayTypeRef[];
}

export interface CatalogReader {
  getServiceTypeDetail(code: string): Promise<ServiceTypeDetail | null>;
}

export interface CatalogRepository extends CatalogReader {
  listServiceTypes(): Promise<ServiceTypeDetail[]>;
}
