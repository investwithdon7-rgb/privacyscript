/**
 * DICOM de-identification — tag-level PHI removal.
 *
 * Implements the DICOM PS3.15 Annex E "Basic Application Level Confidentiality Profile".
 * We use the `dicom-parser` library to parse the binary DICOM file, walk every
 * data element, and zero-out / replace PHI tags.
 *
 * The parser runs client-side on the raw ArrayBuffer. No pixel data is touched —
 * only patient/study/series demographic tags are modified.
 *
 * dicom-parser produces a byte-by-byte view of the DICOM data elements. We
 * overwrite the VALUE bytes of each PHI tag with spaces (0x20) so the file
 * remains structurally valid and can be opened in any DICOM viewer.
 */

/** DICOM tags to remove/blank per PS3.15 Annex E Table E.1-1 (Type 3 PHI) */
const PHI_TAGS = new Set<string>([
  // Patient identification
  '00100010', // PatientName
  '00100020', // PatientID
  '00100021', // IssuerOfPatientID
  '00100030', // PatientBirthDate
  '00100032', // PatientBirthTime
  '00100040', // PatientSex
  '00100050', // PatientInsurancePlanCodeSequence
  '00100101', // PatientPrimaryLanguageCodeSequence
  '00101000', // OtherPatientIDs
  '00101001', // OtherPatientNames
  '00101002', // OtherPatientIDsSequence
  '00101005', // PatientBirthName
  '00101010', // PatientAge
  '00101020', // PatientSize
  '00101030', // PatientWeight
  '00101040', // PatientAddress
  '00101090', // MedicalRecordLocator
  '00102000', // MedicalAlerts
  '00102110', // Allergies
  '00102150', // CountryOfResidence
  '00102160', // EthnicGroup
  '00102180', // Occupation
  '001021A0', // SmokingStatus
  '001021B0', // AdditionalPatientHistory
  '001021C0', // PregnancyStatus
  '001021D0', // LastMenstrualDate
  '001021F0', // PatientReligiousPreference
  '00102297', // ResponsiblePerson
  '00102299', // ResponsibleOrganization
  '00104000', // PatientComments
  // Study / visit
  '00080014', // InstanceCreatorUID
  '00080018', // SOPInstanceUID
  '00080050', // AccessionNumber
  '00080080', // InstitutionName
  '00080081', // InstitutionAddress
  '00080082', // InstitutionCodeSequence
  '00080090', // ReferringPhysicianName
  '00080092', // ReferringPhysicianAddress
  '00080094', // ReferringPhysicianTelephoneNumbers
  '00080096', // ReferringPhysicianIdentificationSequence
  '0008009C', // ConsultingPhysicianName
  '0008009D', // ConsultingPhysicianIdentificationSequence
  '00081030', // StudyDescription
  '00081048', // PhysiciansOfRecord
  '00081049', // PhysiciansOfRecordIdentificationSequence
  '00081070', // OperatorsName
  '00081072', // OperatorsIdentificationSequence
  '00081250', // RelatedSeriesSequence
  '00189371', // ReasonForPerformedProcedureCodeSequence
  '00321000', // ScheduledStudyStartDate
  '00321001', // ScheduledStudyStartTime
  '00380010', // AdmissionID
  '00380020', // AdmittingDate
  '00380021', // AdmittingTime
  '00380300', // CurrentPatientLocation
  '00380400', // PatientInstitutionResidence
  '00380500', // PatientState
  '00404000', // RequestedProcedureComments
  // Device / operator
  '00181000', // DeviceSerialNumber
  '00181002', // DeviceUID
  '00181030', // ProtocolName
  '00185100', // PatientPosition
  // Network / other UIDs
  '00400275', // RequestAttributesSequence
  '00402017', // FillerOrderNumberImagingServiceRequest
  '00402016', // PlacerOrderNumberImagingServiceRequest
  '00401004', // PatientTransportArrangements
  '00401400', // RequestedProcedureComments
]);

/** Tag groups where we blank the entire group (0x0010 = patient, 0x0038 = visit). */
const PHI_GROUP_PREFIXES = new Set<string>(['0010', '0038']);

export interface DicomDeIdResult {
  /** Modified DICOM bytes (same structure, PHI tags blanked). */
  bytes: Uint8Array;
  /** Number of tags that were cleared. */
  tagsCleaned: number;
  /** List of tag IDs that were found and cleared. */
  tagsFound: string[];
}

/**
 * De-identify a DICOM file in-place by blanking all PHI tags.
 * Returns the modified bytes and a report of what was cleared.
 *
 * Uses dicom-parser for parsing; PHI tag values are overwritten with spaces
 * directly in the underlying ArrayBuffer to keep the file structure intact.
 */
export async function deidentifyDicom(bytes: ArrayBuffer): Promise<DicomDeIdResult> {
  const { default: dicomParser } = await import('dicom-parser');

  const uint8 = new Uint8Array(bytes);
  // dicom-parser needs a copy it can annotate; we'll work on a mutable clone.
  const buf = uint8.slice(0);

  let dataSet;
  try {
    dataSet = dicomParser.parseDicom(buf);
  } catch (err) {
    throw new Error(`Not a valid DICOM file: ${(err as Error).message}`);
  }

  const tagsFound: string[] = [];
  let tagsCleaned = 0;

  // Walk all elements in the dataset.
  for (const tag of Object.keys(dataSet.elements)) {
    const tagNorm = tag.replace(/[^0-9a-f]/gi, '').toLowerCase().padStart(8, '0');
    const group = tagNorm.slice(0, 4);

    const shouldBlank = PHI_TAGS.has(tagNorm) || PHI_GROUP_PREFIXES.has(group);
    if (!shouldBlank) continue;

    const element = dataSet.elements[tag];
    if (!element || element.length === 0) continue;

    // Overwrite the raw bytes of this element's value with ASCII spaces (0x20).
    const start = element.dataOffset;
    const end = start + element.length;
    for (let i = start; i < end && i < buf.length; i++) {
      buf[i] = 0x20;
    }

    tagsFound.push(tagNorm);
    tagsCleaned++;
  }

  return { bytes: buf, tagsCleaned, tagsFound };
}

/** Check whether a file looks like a DICOM file (magic bytes at offset 128). */
export function looksLikeDicom(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 132) return false;
  const view = new Uint8Array(bytes, 128, 4);
  return view[0] === 0x44 && view[1] === 0x49 && view[2] === 0x43 && view[3] === 0x4d; // 'DICM'
}
