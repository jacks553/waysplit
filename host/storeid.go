package main

// storeExtensionID — ID расширения в Chrome Web Store (SPEC-STORE.md, 1.1). Магазин назначил его
// при первой загрузке архива (черновик, 2026-11-09), и он не совпадает с ID для разработки
// (extensionID из поля key — его же у расширения для ручной установки из выпуска на GitHub).
// Компаньон пускает оба: тот же компаньон работает и с ручной копией, и с версией из магазина.
const storeExtensionID = "fdgapnefknckjikbklcanoklhnmcgklg"

// extensionIDs — каким расширениям компаньон разрешает подключаться (allowed_origins):
// версии для разработки и версии из магазина.
func extensionIDs() []string {
	// Порядок: сначала ID для разработки, потом из магазина.
	ids := []string{extensionID}
	if storeExtensionID != "" && storeExtensionID != extensionID {
		ids = append(ids, storeExtensionID)
	}
	return ids
}

// validExtID — ID расширения Chrome: 32 буквы a–p.
func validExtID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, c := range id {
		if c < 'a' || c > 'p' {
			return false
		}
	}
	return true
}
