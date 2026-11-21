import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.main import danger_check, extract_record

def test_pregnancy_bleeding_flag():
    assert danger_check("The beneficiary reports bleeding during pregnancy.")

def test_newborn_fever_flag():
    assert danger_check("Newborn has high fever.")

def test_normal_note_no_flag():
    assert danger_check("ANC checkup completed, weight 52 kilo.") == []

def test_weight_extraction():
    record = extract_record("ANC checkup, weight 2.8 kilo, TT injection completed.", "SYN-1001")
    assert record["weight_kg"] == 2.8
    assert record["visit_type"] == "ANC"


def test_code_mixed_danger_phrase():
    assert danger_check("Pregnancy lo bleeding agide")

def test_newborn_kannada_fever_phrase():
    assert danger_check("ನವಜಾತ ಶಿಶುವಿಗೆ ಹೆಚ್ಚಿನ ಜ್ವರ")

def test_next_visit_month_name():
    record = extract_record("ANC checkup next visit December 5 2026", "SYN-1003")
    assert record["next_visit_date"] == "2026-12-05"


def test_maternal_fever_phrase():
    assert danger_check("Pregnant woman has high fever")

def test_newborn_not_feeding_phrase():
    assert danger_check("newborn not feeding")
